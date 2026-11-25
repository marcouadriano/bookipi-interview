// Sale Service against a real Redis and a real Postgres.
// The two apps run as real processes and are driven over HTTP. The Order Service is not running here:
// where a test needs its output, the test writes to the results stream itself.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';

import {
  buy,
  join,
  purchaseState,
  queue,
  shutdown,
  waitAdmitted,
  waitReady,
  waitRebuilt,
} from './support/api';
import { env, ports, saleKey, streams } from './support/env';
import { call } from './support/http';
import { addResult, connect, pendingCount, readStream, reset, type Infra } from './support/infra';
import type { App } from './support/proc';
import { startPurchase, startWaitingRoom } from './support/sale';
import { sleep, until } from './support/util';

const WR = ports.waitingRoom;
const WR2 = ports.waitingRoom2;
const PA = ports.purchase;
const HOUR = 3600_000;

let infra: Infra;

before(async () => {
  infra = await connect();
});
after(async () => {
  await infra.close();
});

const stock = () => infra.redis.get(saleKey('stock'));

const insertBuyers = async (...users: string[]) => {
  for (const u of users) {
    await infra.db.query(
      'INSERT INTO orders (sale_id, user_id, reserved_at, order_message_id) VALUES ($1, $2, now(), $3)',
      [env.saleId, u, `1-${u}`],
    );
  }
};

describe('before the ready marker exists', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 3);
    apps = [await startWaitingRoom(WR)]; // no Purchase app, so nothing rebuilds Redis
  });
  after(() => shutdown(apps));

  it('reports the marker as missing on /health', async () => {
    const res = await call(WR, 'GET', '/health');
    assert.deepEqual(res.body, { status: 'ok', redis: 'up', ready: false });
  });

  it('closes joining with 503 and Retry-After instead of running on empty numbers', async () => {
    const res = await join('early');
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'temporarily_unavailable');
    assert.ok(res.headers.get('retry-after'));
  });

  it('still answers the sale status, from the clock', async () => {
    const res = await call(WR, 'GET', '/api/sale');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'active');
  });

  it('opens once a Purchase app has rebuilt Redis: stock is TOTAL_STOCK, and the line works', async () => {
    const purchase = await startPurchase(PA);
    apps.push(purchase);
    await waitReady();
    assert.equal(await stock(), '3');
    assert.equal((await join('early')).status, 200);
  });
});

describe('outside the sale window', () => {
  it('before the start: status upcoming, joining and buying are refused, nobody is admitted', async () => {
    await reset(infra, 3);
    const t = Date.now();
    const times = {
      SALE_START: new Date(t + HOUR).toISOString(),
      SALE_END: new Date(t + 2 * HOUR).toISOString(),
    };
    const apps = [await startWaitingRoom(WR, times), await startPurchase(PA, times)];

    try {
      await waitReady();
      assert.equal((await call(WR, 'GET', '/api/sale')).body.status, 'upcoming');
      const joined = await join('early');
      assert.deepEqual([joined.status, joined.body.error.code], [403, 'sale_not_active']);
      const bought = await buy('early');
      assert.deepEqual(
        [bought.status, bought.body],
        [
          403,
          {
            outcome: 'sale_not_active',
            userId: 'early',
            saleStatus: 'upcoming',
          },
        ],
      );

      // Five people are already in line (joining is refused, so we add them by hand): a pop that
      // ignored the sale window would admit them.
      await infra.redis.set(saleKey('last'), 5);
      await sleep(1500);
      assert.equal(await infra.redis.exists(saleKey('serving')), 0);
    } finally {
      await shutdown(apps);
    }
  });

  it('after the end: status ended, joining and buying are refused', async () => {
    await reset(infra, 3);
    const t = Date.now();
    const times = {
      SALE_START: new Date(t - 2 * HOUR).toISOString(),
      SALE_END: new Date(t - HOUR).toISOString(),
    };
    const apps = [await startWaitingRoom(WR, times), await startPurchase(PA, times)];

    try {
      await waitReady();
      assert.equal((await call(WR, 'GET', '/api/sale')).body.status, 'ended');
      assert.equal((await join('late')).body.error.code, 'sale_not_active');
      const bought = await buy('late');
      assert.deepEqual(
        [bought.status, bought.body.outcome, bought.body.saleStatus],
        [403, 'sale_not_active', 'ended'],
      );

      // Five people are in line (added by hand, as joining is refused): a pop that ignored the
      // sale window would admit them, because the tick number is large and positive after the end.
      await infra.redis.set(saleKey('last'), 5);
      await sleep(1500);
      assert.equal(await infra.redis.exists(saleKey('serving')), 0);
    } finally {
      await shutdown(apps);
    }
  });
});

describe('the waiting line', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 100);
    // Two Waiting Room instances share one line; a long window so nobody expires during the test.
    const extra = { TOTAL_STOCK: '100', ADMIT_WINDOW_MS: '8000' };
    apps = [
      await startWaitingRoom(WR, extra),
      await startWaitingRoom(WR2, extra),
      await startPurchase(PA, extra),
    ];
    await waitReady();
  });
  after(() => shutdown(apps));

  it('reports the sale: active, a 1 hour window, and the server time', async () => {
    const res = await call(WR, 'GET', '/api/sale');
    assert.equal(res.body.status, 'active');
    assert.equal(Date.parse(res.body.endsAt) - Date.parse(res.body.startsAt), HOUR);
    assert.ok(Math.abs(Date.parse(res.body.serverTime) - Date.now()) < 5000);
  });

  it('rejects invalid input with 400 invalid_user_id', async () => {
    for (const body of [
      { userId: 'bad id!' },
      { userId: '' },
      { userId: 'x'.repeat(65) },
      {},
      { userId: 5 },
    ]) {
      const res = await call(WR, 'POST', '/api/queue', body);
      assert.deepEqual(
        [res.status, res.body.error.code],
        [400, 'invalid_user_id'],
        JSON.stringify(body),
      );
    }

    const malformed = await fetch(`http://localhost:${WR}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nope',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await call(WR, 'GET', '/api/queue/bad%20id')).status, 400);
  });

  it('answers 404 for a user who is not in the line, and `none` for a user with no purchase', async () => {
    assert.equal((await queue('nobody')).status, 404);
    assert.deepEqual((await purchaseState('nobody')).body, {
      userId: 'nobody',
      state: 'none',
    });
  });

  it('normalises the user ID; joining again keeps the same place; both instances agree', async () => {
    const first = await join('  Alice@Example.COM ', WR);
    assert.equal(first.status, 200);
    assert.equal(first.body.userId, 'alice@example.com');
    const again = await join('alice@example.com', WR2);
    assert.equal(again.body.userId, 'alice@example.com');
    assert.ok(['waiting', 'admitted'].includes(again.body.state));
    assert.equal(await infra.redis.hlen(saleKey('tickets')), 1); // one ticket, not two
  });

  it('admits in joining order, at most N per pop, and a window of D from the pop', async () => {
    const users = Array.from({ length: 6 }, (_, i) => `fifo${i}`);
    for (const u of users) await join(u, Math.random() < 0.5 ? WR : WR2); // sequential: the ticket order is known
    for (const u of users) await waitAdmitted(u);

    const until_ = await Promise.all(
      users.map(async (u) => Date.parse((await queue(u)).body.admittedUntil)),
    );
    assert.deepEqual(
      [...until_].sort((a, b) => a - b),
      until_,
      'someone behind in the line was admitted before someone ahead',
    );
    const perPop = new Map<number, number>();
    for (const t of until_) perPop.set(t, (perPop.get(t) ?? 0) + 1);
    assert.ok(
      [...perPop.values()].every((n) => n <= 2),
      `more than N=2 admitted at once: ${[...perPop.values()]}`,
    );
    assert.ok(until_.every((t) => t - Date.now() <= 8000 && t > Date.now() - 1000));
  });

  it('pops each tick once even with two instances, and never more than N users per pop', async () => {
    const raw = await infra.redis.zrange(saleKey('pops'), 0, -1, 'WITHSCORES');
    const pops: { at: number; serving: number }[] = [];
    for (let i = 0; i < raw.length; i += 2)
      pops.push({ at: Number(raw[i]), serving: Number(raw[i + 1]) });
    assert.ok(pops.length >= 3);

    // tick = floor((time - SALE_START) / S). A tick popped twice would show up as a repeated tick number.
    const startsAt = Date.parse((await call(WR, 'GET', '/api/sale')).body.startsAt);
    const ticks = pops.map((p) => Math.floor((p.at - startsAt) / 1000));
    assert.deepEqual(
      ticks,
      [...new Set(ticks)].sort((a, b) => a - b),
      `a tick was popped twice: ${ticks}`,
    );
    for (let i = 1; i < pops.length; i++) {
      assert.ok(pops[i].serving - pops[i - 1].serving <= 2, 'popped more than N in one tick');
    }
  });
});

describe('idle connections', () => {
  let apps: App[] = [];

  before(async () => {
    apps = [await startWaitingRoom(WR)];
  });

  after(() => shutdown(apps));

  // Node closes an idle connection after 5 s by default. A load balancer that reuses it at that
  // moment gets a connection reset, so the server has to keep it open longer.
  it('stay open for longer than 5 seconds', async () => {
    const socket = net.connect(WR, 'localhost');
    await once(socket, 'connect');
    socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await once(socket, 'data');

    let closed = false;
    socket.on('close', () => (closed = true));
    await sleep(6000);
    socket.destroy();

    assert.equal(closed, false);
  });
});

describe('the buying window', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 100);
    const extra = { TOTAL_STOCK: '100', ADMIT_WINDOW_MS: '2500' };
    apps = [await startWaitingRoom(WR, extra), await startPurchase(PA, extra)];
    await waitReady();
  });
  after(() => shutdown(apps));

  it('expires after D: the user cannot buy, joining again puts them at the back, and a new admission lets them buy', async () => {
    assert.equal((await join('slowpoke')).status, 200);
    await waitAdmitted('slowpoke');
    const admitted = (await queue('slowpoke')).body;
    const left = Date.parse(admitted.admittedUntil) - Date.now();
    assert.ok(left > 0 && left <= 2500, `window left ${left} ms`);

    await until(
      'window to run out',
      async () => (await queue('slowpoke')).body.state === 'expired',
      8000,
    );
    const late = await buy('slowpoke');
    assert.deepEqual([late.status, late.body.outcome], [403, 'not_admitted']);
    assert.equal(
      await infra.redis.exists(saleKey('buyers')),
      0,
      'a refused purchase must not take stock',
    );

    const rejoined = await join('slowpoke');
    assert.equal(rejoined.status, 200);
    assert.equal(rejoined.body.state, 'waiting');
    await waitAdmitted('slowpoke');
    assert.equal((await buy('slowpoke')).status, 202);
  });
});

describe('buying', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 3);
    const extra = { ADMIT_BATCH_SIZE: '50', ADMIT_WINDOW_MS: '60000' };
    apps = [await startWaitingRoom(WR, extra), await startPurchase(PA, extra)];
    await waitReady();
  });
  after(() => shutdown(apps));

  it('refuses a user who has not been admitted', async () => {
    const res = await buy('nevermind');
    assert.deepEqual([res.status, res.body.outcome], [403, 'not_admitted']);
  });

  it('accepts an admitted user and queues the order', async () => {
    await join('buyer1');
    await waitAdmitted('buyer1');
    const before = Number(await stock());
    const res = await buy('buyer1');
    assert.deepEqual([res.status, res.body], [202, { outcome: 'accepted', userId: 'buyer1' }]);

    assert.equal(Number(await stock()), before - 1);
    assert.equal(await infra.redis.sismember(saleKey('buyers'), 'buyer1'), 1);
    assert.deepEqual((await purchaseState('buyer1')).body, {
      userId: 'buyer1',
      state: 'processing',
    });

    const orders = (await readStream(infra, streams.orders)).filter((m) => m.userId === 'buyer1');
    assert.equal(orders.length, 1);
    assert.equal(orders[0].saleId, env.saleId);
    assert.match(orders[0].reservedAtMs, /^\d{13}$/);
    assert.ok(Math.abs(Number(orders[0].reservedAtMs) - Date.now()) < 60_000);
  });

  it('allows one purchase per user, and keeps them out of the line afterwards', async () => {
    const again = await buy('buyer1');
    assert.deepEqual([again.status, again.body.outcome], [409, 'already_purchased']);
    const joined = await join('buyer1');
    assert.deepEqual([joined.status, joined.body.error.code], [409, 'already_purchased']);
    assert.equal(
      (await readStream(infra, streams.orders)).filter((m) => m.userId === 'buyer1').length,
      1,
    );
  });

  it('treats the same person typed two ways as one user', async () => {
    const res = await call(PA, 'POST', '/api/purchase', { userId: ' BUYER1 ' });
    assert.deepEqual(
      [res.status, res.body.outcome, res.body.userId],
      [409, 'already_purchased', 'buyer1'],
    );
  });
});

describe('many users at once', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 3);
    const extra = { ADMIT_BATCH_SIZE: '50', ADMIT_WINDOW_MS: '60000' };
    apps = [
      await startWaitingRoom(WR, extra),
      await startWaitingRoom(WR2, extra),
      await startPurchase(PA, extra),
    ];
    await waitReady();
  });
  after(() => shutdown(apps));

  it('never sells more than the stock: 40 admitted users buy at the same moment, exactly 3 win', async () => {
    const users = Array.from({ length: 40 }, (_, i) => `rush${i}`);
    await Promise.all(users.map((u, i) => join(u, i % 2 ? WR : WR2)));
    for (const u of users) await waitAdmitted(u);

    const replies = await Promise.all(users.map((u) => buy(u)));
    const outcomes = replies.map((r) => r.body.outcome);
    assert.equal(outcomes.filter((o) => o === 'accepted').length, 3);
    assert.equal(outcomes.filter((o) => o === 'sold_out').length, 37);
    assert.ok(
      replies.every((r) => (r.body.outcome === 'accepted' ? r.status === 202 : r.status === 409)),
    );

    assert.equal(await stock(), '0');
    assert.equal(await infra.redis.scard(saleKey('buyers')), 3);
    assert.equal(await infra.redis.xlen(streams.orders), 3, 'one order message per sold unit');
    const winners = users.filter((_, i) => outcomes[i] === 'accepted');
    for (const u of winners) assert.equal((await purchaseState(u)).body.state, 'processing');
    for (const u of users.filter((_, i) => outcomes[i] !== 'accepted'))
      assert.equal((await purchaseState(u)).body.state, 'none');
  });

  it('then ends the sale: status sold_out, joining refused, and the line stops moving', async () => {
    assert.equal((await call(WR, 'GET', '/api/sale')).body.status, 'sold_out');
    const joined = await join('toolate');
    assert.deepEqual([joined.status, joined.body.error.code], [403, 'sale_not_active']);
    // One more person is waiting (joining is refused, so we add the ticket by hand): a pop that
    // ignored the empty stock would admit them.
    await infra.redis.incr(saleKey('last'));
    const serving = await infra.redis.get(saleKey('serving'));
    await sleep(2500);
    assert.equal(
      await infra.redis.get(saleKey('serving')),
      serving,
      'someone was admitted after the stock ran out',
    );
  });
});

describe('results from the Order Service', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 5);
    const extra = {
      TOTAL_STOCK: '5',
      ADMIT_BATCH_SIZE: '50',
      ADMIT_WINDOW_MS: '60000',
    };
    apps = [await startWaitingRoom(WR, extra), await startPurchase(PA, extra)];
    await waitReady();
    for (const u of ['ra', 'rb', 'rc', 'rd']) await join(u);
    for (const u of ['ra', 'rb', 'rc', 'rd']) await waitAdmitted(u);
  });
  after(() => shutdown(apps));

  it('`recorded` turns processing into success, and a repeat changes nothing', async () => {
    await buy('ra');
    await addResult(infra, 'ra', 'recorded');
    await until('success', async () => (await purchaseState('ra')).body.state === 'success');
    await addResult(infra, 'ra', 'recorded');
    await until(
      'both results applied',
      async () => (await call(PA, 'GET', '/health')).body.resultsBacklog === 0,
    );
    assert.deepEqual((await purchaseState('ra')).body, {
      userId: 'ra',
      state: 'success',
    });
  });

  it('`failed` turns processing into failed with the reason', async () => {
    await buy('rb');
    await addResult(infra, 'rb', 'failed', 'processing_error');
    await until('failed', async () => (await purchaseState('rb')).body.state === 'failed');
    assert.deepEqual((await purchaseState('rb')).body, {
      userId: 'rb',
      state: 'failed',
      reason: 'processing_error',
    });
  });

  it('a `sold_out` failure also sets stock to 0, so the sale ends at once and nobody else can buy', async () => {
    await buy('rc');
    assert.equal(await stock(), '2'); // three of five units sold, so the stock is not what ends the sale
    await addResult(infra, 'rc', 'failed', 'sold_out'); // the Order Service says Postgres is out of stock
    await until(
      'sale sold out',
      async () => (await call(WR, 'GET', '/api/sale')).body.status === 'sold_out',
    );
    assert.equal(await stock(), '0');
    assert.deepEqual((await purchaseState('rc')).body, {
      userId: 'rc',
      state: 'failed',
      reason: 'sold_out',
    });
    const res = await buy('rd'); // admitted, and Redis still had two units a moment ago
    assert.deepEqual([res.status, res.body.outcome], [409, 'sold_out']);
  });

  it('skips a malformed result and acknowledges it, so the reader keeps going', async () => {
    await infra.redis.xadd(streams.results, '*', 'junk', 'yes');
    await addResult(infra, 'after-junk', 'recorded');
    await until(
      'the result after the junk',
      async () => (await purchaseState('after-junk')).body.state === 'success',
    );
    await until(
      'nothing left pending',
      async () => (await pendingCount(infra, streams.results, 'sale-service')) === 0,
    );
  });
});

describe('the results reader after a crash', () => {
  it('picks up results that a crashed instance read but never applied', async () => {
    await reset(infra, 3);
    await infra.redis.xgroup('CREATE', streams.results, 'sale-service', '0', 'MKSTREAM');
    await addResult(infra, 'orphan', 'recorded');
    await infra.redis.call(
      'XREADGROUP',
      'GROUP',
      'sale-service',
      'purchase-app',
      'COUNT',
      10,
      'STREAMS',
      streams.results,
      '>',
    ); // read, never acknowledged
    assert.equal(await pendingCount(infra, streams.results, 'sale-service'), 1);

    const apps = [await startPurchase(PA)];
    try {
      await until(
        'orphaned result applied',
        async () => (await purchaseState('orphan')).body.state === 'success',
      );
      await until(
        'acknowledged',
        async () => (await pendingCount(infra, streams.results, 'sale-service')) === 0,
      );
    } finally {
      await shutdown(apps);
    }
  });

  it('applies results that arrived while no Purchase app was running', async () => {
    await reset(infra, 3);
    await addResult(infra, 'offline1', 'recorded');
    await addResult(infra, 'offline2', 'failed', 'processing_error');
    const apps = [await startPurchase(PA)];
    try {
      await until(
        'both applied',
        async () =>
          (await purchaseState('offline1')).body.state === 'success' &&
          (await purchaseState('offline2')).body.state === 'failed',
      );
    } finally {
      await shutdown(apps);
    }
  });
});

describe('rebuilding Redis from Postgres', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 5);
    await insertBuyers('alice', 'bob'); // already bought, according to Postgres
    apps = [
      await startWaitingRoom(WR, { TOTAL_STOCK: '5' }),
      await startPurchase(PA, { TOTAL_STOCK: '5' }),
    ];
    await waitReady();
  });
  after(() => shutdown(apps));

  it('at startup: buyers come from Postgres, stock is TOTAL_STOCK minus buyers, states are success', async () => {
    assert.equal(await infra.redis.scard(saleKey('buyers')), 2);
    assert.equal(await stock(), '3');
    assert.equal((await purchaseState('alice')).body.state, 'success');
    assert.equal((await join('bob')).body.error.code, 'already_purchased');
    assert.equal((await buy('alice')).body.outcome, 'already_purchased');
  });

  it('while the marker is missing, purchases and joining get 503; a rebuild already running elsewhere is respected', async () => {
    await infra.redis.set(saleKey('rebuildLock'), 'another-instance', 'PX', 4000); // someone else is rebuilding
    await infra.redis.del(saleKey('ready'));
    const bought = await buy('carol');
    assert.deepEqual([bought.status, bought.body.error.code], [503, 'temporarily_unavailable']);
    assert.ok(bought.headers.get('retry-after'));
    assert.equal((await join('carol')).status, 503);
    await sleep(1000);
    assert.equal(
      await infra.redis.exists(saleKey('ready')),
      0,
      'rebuilt while another instance held the lock',
    );

    await infra.redis.del(saleKey('rebuildLock')); // the other instance is done (or died)
    await until(
      'the Purchase app rebuilds by itself',
      async () => (await infra.redis.exists(saleKey('ready'))) === 1,
      10_000,
    );
    assert.equal((await join('carol')).status, 200);
  });

  it('keeps a buyer that only Redis knows (accepted, not yet in Postgres) and adds one that only Postgres knows', async () => {
    await infra.redis.sadd(saleKey('buyers'), 'redis-only');
    await infra.redis.hset(saleKey('purchases'), 'redis-only', 'processing');
    await insertBuyers('postgres-only');
    await infra.redis.del(saleKey('ready'));
    await waitRebuilt(infra);

    const buyers = (await infra.redis.smembers(saleKey('buyers'))).sort();
    assert.deepEqual(buyers, ['alice', 'bob', 'postgres-only', 'redis-only']);
    assert.equal((await purchaseState('redis-only')).body.state, 'processing');
    assert.equal((await purchaseState('postgres-only')).body.state, 'success');
    assert.equal(await stock(), '1');
  });

  it('recovers from a Redis that lost all its sale data', async () => {
    const keys = await infra.redis.keys('sale:*');
    await infra.redis.del(...keys);
    await waitRebuilt(infra);
    assert.deepEqual((await infra.redis.smembers(saleKey('buyers'))).sort(), [
      'alice',
      'bob',
      'postgres-only',
    ]);
    assert.equal(await stock(), '2');
    assert.equal((await purchaseState('bob')).body.state, 'success');
    assert.equal((await call(WR, 'GET', '/api/sale')).body.status, 'active');
  });

  it('never lets stock go negative when Postgres already has more buyers than the stock', async () => {
    await insertBuyers('x1', 'x2', 'x3');
    await infra.redis.del(saleKey('ready'));
    await waitRebuilt(infra);
    assert.equal(await stock(), '0');
    assert.equal((await call(WR, 'GET', '/api/sale')).body.status, 'sold_out');
  });
});

describe('rebuilding when Postgres is not available', () => {
  it('stays closed, keeps retrying, and opens once Postgres is reachable', async () => {
    await reset(infra, 3);
    const brokenUrl = env.readerUrl.replace('readerpw', 'wrong');
    const wr = await startWaitingRoom(WR);

    try {
      const bad = await startPurchase(PA, {
        SALE_READER_DATABASE_URL: brokenUrl,
      });
      try {
        await until('the failure to be logged', () => /rebuild failed/.test(bad.logs()), 15_000);
        assert.equal(await infra.redis.exists(saleKey('ready')), 0);
        assert.equal((await call(PA, 'GET', '/health')).body.ready, false);
        assert.equal((await buy('someone')).status, 503);
        assert.equal((await join('someone')).status, 503);
        await until(
          'a second attempt (backoff)',
          () => (bad.logs().match(/rebuild failed/g) ?? []).length >= 2,
          15_000,
        );
      } finally {
        await bad.stop();
      }

      const good = await startPurchase(PA);
      try {
        await waitReady();
        assert.equal((await join('someone')).status, 200);
      } finally {
        await shutdown([good, wr]);
      }
    } finally {
      await wr.stop(); // a failure above must not leave it on the port for the next test
    }
  });

  it('two Purchase instances starting together agree on the result', async () => {
    await reset(infra, 5);
    await insertBuyers('p1', 'p2', 'p3');
    const apps = [
      await startPurchase(PA, { TOTAL_STOCK: '5' }),
      await startPurchase(ports.purchase2, { TOTAL_STOCK: '5' }),
    ];

    try {
      await waitReady();
      await sleep(1000); // let both finish whatever they are doing
      assert.deepEqual((await infra.redis.smembers(saleKey('buyers'))).sort(), ['p1', 'p2', 'p3']);
      assert.equal(await stock(), '2');
      assert.equal(await infra.redis.exists(saleKey('rebuildLock')), 0, 'the lock was released');
      for (const a of apps) assert.equal((await call(a.port, 'GET', '/health')).body.ready, true);
    } finally {
      await shutdown(apps);
    }
  });
});

describe('rate limits', () => {
  it('per user: the limit counts joins and buys together, answers 429 with Retry-After, and spares other users', async () => {
    await reset(infra, 3);
    const extra = {
      RATE_LIMIT_USER_MAX: '4',
      RATE_LIMIT_USER_WINDOW_MS: '3000',
    };
    const apps = [await startWaitingRoom(WR, extra), await startPurchase(PA, extra)];

    try {
      await waitReady();
      // Wait for the start of a fresh window so the requests below land in the same one.
      await until('a fresh window', () => Date.now() % 3000 < 300, 4000);
      const statuses: number[] = [];
      statuses.push((await join('spammer')).status, (await join('spammer')).status);
      statuses.push((await buy('spammer')).status, (await buy('spammer')).status);
      assert.ok(
        statuses.every((s) => s !== 429),
        `limited too early: ${statuses}`,
      );

      const limited = await join('spammer');
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error.code, 'rate_limited');
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);
      assert.equal((await buy('spammer')).status, 429);

      assert.notEqual((await join('other-user')).status, 429);
      for (let i = 0; i < 10; i++)
        assert.notEqual(
          (await queue('spammer')).status,
          429,
          'reading must not be limited per user',
        );
    } finally {
      await shutdown(apps);
    }
  });

  it('per IP: limits every endpoint except /health, and the window resets', async () => {
    await reset(infra, 3);
    const apps = [
      await startWaitingRoom(WR, {
        RATE_LIMIT_IP_ENABLED: 'true',
        RATE_LIMIT_IP_MAX: '4',
        RATE_LIMIT_IP_WINDOW_MS: '2000',
      }),
    ];

    try {
      // Wait for the start of a fresh window so the four requests below land in the same one.
      await until('a fresh window', () => Date.now() % 2000 < 300, 3000);

      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await call(WR, 'GET', '/api/sale')).status);
      assert.deepEqual(codes, [200, 200, 200, 200, 429]);
      const limited = await call(WR, 'GET', '/api/sale');
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);
      assert.equal((await call(WR, 'GET', '/health')).status, 200, '/health is never limited');

      await sleep(2100);
      assert.equal((await call(WR, 'GET', '/api/sale')).status, 200);
    } finally {
      await shutdown(apps);
    }
  });
});
