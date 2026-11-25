// Both Sale Service apps and the real Order Service worker together, over a real Redis and Postgres.
// Postgres is the source of truth for who bought.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  buy,
  join,
  purchaseState,
  saleStatus,
  shutdown,
  waitAdmitted,
  waitReady,
  waitRebuilt,
} from './support/api';
import { ports, saleKey, streams } from './support/env';
import { call } from './support/http';
import {
  connect,
  orderUsers,
  pendingCount,
  readStream,
  reset,
  resultsFor,
  soldCount,
  type Infra,
} from './support/infra';
import type { App } from './support/proc';
import { startOrderWorker, startPurchase, startWaitingRoom } from './support/sale';
import { sleep, until } from './support/util';

let infra: Infra;
before(async () => {
  infra = await connect();
});
after(async () => {
  await infra.close();
});

const sale = (totalStock: number) => ({
  TOTAL_STOCK: String(totalStock),
  ADMIT_BATCH_SIZE: '50',
  ADMIT_WINDOW_MS: '60000',
});
const waitState = (userId: string, state: string, ms = 15_000) =>
  until(
    `${userId} to be ${state}`,
    async () => (await purchaseState(userId)).body.state === state,
    ms,
  );

describe('one purchase, start to finish', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 3);
    apps = [
      await startOrderWorker(),
      await startWaitingRoom(ports.waitingRoom, sale(3)),
      await startPurchase(ports.purchase, sale(3)),
    ];
    await waitReady();
  });
  after(() => shutdown(apps));

  it('join, get admitted, buy, and see "success" only once the order is in Postgres', async () => {
    assert.equal((await join('Marco@Example.com')).status, 200);
    await waitAdmitted('marco@example.com');
    const bought = await buy('marco@example.com');
    assert.deepEqual([bought.status, bought.body.outcome], [202, 'accepted']);

    await waitState('marco@example.com', 'success');
    assert.deepEqual(await orderUsers(infra), ['marco@example.com']);
    assert.equal(await soldCount(infra), 1);
    const results = await resultsFor(infra, 'marco@example.com');
    assert.deepEqual(
      results.map((r) => r.status),
      ['recorded'],
    );
    await until(
      'everything acknowledged',
      async () =>
        (await pendingCount(infra, streams.orders, 'order-service')) === 0 &&
        (await pendingCount(infra, streams.results, 'sale-service')) === 0,
    );
  });

  it('the Postgres row carries the purchase time Redis took, and the stream message id as the purchase order', async () => {
    const row = (await infra.db.query('SELECT user_id, reserved_at, order_message_id FROM orders'))
      .rows[0];
    const message = (await readStream(infra, streams.orders))[0];
    assert.equal(row.order_message_id, message.id);
    assert.equal(row.reserved_at.getTime(), Number(message.reservedAtMs));
  });

  it('a second purchase and a second join are both refused, and nothing more is stored', async () => {
    assert.equal((await buy('marco@example.com')).body.outcome, 'already_purchased');
    assert.equal((await join('marco@example.com')).body.error.code, 'already_purchased');
    await sleep(500);
    assert.equal((await orderUsers(infra)).length, 1);
  });

  it('"Check my order" for someone who never bought says none', async () => {
    assert.equal((await purchaseState('stranger')).body.state, 'none');
  });
});

describe('selling out', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 3);
    apps = [
      await startOrderWorker(),
      await startWaitingRoom(ports.waitingRoom, sale(3)),
      await startWaitingRoom(ports.waitingRoom2, sale(3)),
      await startPurchase(ports.purchase, sale(3)),
    ];
    await waitReady();
  });
  after(() => shutdown(apps));

  it('with 30 people buying at once, exactly the stock is sold: Redis, the order stream and Postgres all agree', async () => {
    const users = Array.from({ length: 30 }, (_, i) => `crowd${i}`);
    await Promise.all(users.map((u, i) => join(u, i % 2 ? ports.waitingRoom : ports.waitingRoom2)));
    for (const u of users) await waitAdmitted(u);
    const replies = await Promise.all(users.map((u) => buy(u)));
    const winners = users.filter((_, i) => replies[i].body.outcome === 'accepted');
    assert.equal(winners.length, 3);
    assert.equal(replies.filter((r) => r.body.outcome === 'sold_out').length, 27);

    for (const u of winners) await waitState(u, 'success');
    assert.deepEqual((await orderUsers(infra)).sort(), [...winners].sort());
    assert.equal(await soldCount(infra), 3);
    assert.equal(await infra.redis.xlen(streams.orders), 3);
    assert.equal(await infra.redis.get(saleKey('stock')), '0');
    assert.equal(
      (await readStream(infra, streams.failed)).length,
      0,
      'nothing should have failed: Redis never oversold',
    );
  });

  it('the page sees the sale as sold out', async () => {
    assert.equal(await saleStatus(), 'sold_out');
    assert.equal((await join('latecomer')).body.error.code, 'sale_not_active');
  });
});

describe('when Redis sold more than Postgres has', () => {
  let apps: App[] = [];
  let worker: App;
  before(async () => {
    await reset(infra, 2); // Postgres allows 2 ...
    worker = await startOrderWorker();
    // ... while the Sale Service is told there are 4. This is the "Redis oversold" case the design guards against.
    apps = [
      worker,
      await startWaitingRoom(ports.waitingRoom, sale(4)),
      await startPurchase(ports.purchase, sale(4)),
    ];
    await waitReady();
  });
  after(() => shutdown(apps));

  it('Postgres keeps the earliest purchases and the rest fail as sold_out', async () => {
    assert.equal(await infra.redis.get(saleKey('stock')), '4');
    const users = ['i1', 'i2', 'i3', 'i4'];
    for (const u of users) await join(u);
    for (const u of users) await waitAdmitted(u);
    const replies = await Promise.all(users.map((u) => buy(u)));
    assert.ok(
      replies.every((r) => r.body.outcome === 'accepted'),
      'Redis should have accepted all four',
    );

    const order = (await readStream(infra, streams.orders)).map((m) => m.userId); // true purchase order
    const [kept, dropped] = [order.slice(0, 2), order.slice(2)];
    for (const u of kept) await waitState(u, 'success');
    for (const u of dropped) await waitState(u, 'failed');

    assert.deepEqual(
      (await orderUsers(infra)).sort(),
      [...kept].sort(),
      'the two earliest purchases are the ones in Postgres',
    );
    assert.equal(await soldCount(infra), 2);

    for (const u of dropped) {
      assert.deepEqual((await purchaseState(u)).body, {
        userId: u,
        state: 'failed',
        reason: 'sold_out',
      });
    }

    assert.deepEqual(
      (await readStream(infra, streams.failed)).map((f) => f.reason),
      ['sold_out', 'sold_out'],
    );
    assert.match(worker.logs(), /INTEGRITY_ALERT/);
  });

  it('and the Sale Service stops selling: stock 0, status sold_out, nobody new gets in', async () => {
    assert.equal(await infra.redis.get(saleKey('stock')), '0');
    assert.equal(await saleStatus(), 'sold_out');
    assert.equal((await join('i5')).body.error.code, 'sale_not_active');
  });
});

describe('when the Order Service is not running', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 5);
    apps = [
      await startWaitingRoom(ports.waitingRoom, sale(5)),
      await startPurchase(ports.purchase, sale(5)),
    ];
    await waitReady();
  });
  after(() => shutdown(apps));

  it('purchases are accepted and stay "processing", never "success", until the order is stored', async () => {
    for (const u of ['w1', 'w2']) await join(u);
    for (const u of ['w1', 'w2']) await waitAdmitted(u);
    assert.equal((await buy('w1')).status, 202);
    assert.equal((await buy('w2')).status, 202);
    await sleep(2500);
    assert.equal((await purchaseState('w1')).body.state, 'processing');
    assert.deepEqual(await orderUsers(infra), []);
    assert.equal(
      await infra.redis.xlen(streams.orders),
      2,
      'the accepted purchases wait in the stream',
    );
  });

  it('and they all complete when the Order Service starts, with nothing lost', async () => {
    const worker = await startOrderWorker();
    try {
      await waitState('w1', 'success');
      await waitState('w2', 'success');
      assert.deepEqual((await orderUsers(infra)).sort(), ['w1', 'w2']);
      assert.equal(await soldCount(infra), 2);
    } finally {
      await shutdown([worker]);
    }
  });

  it('a worker that is killed mid-sale loses nothing: another worker finishes the job', async () => {
    const doomed = await startOrderWorker();
    for (const u of ['k1', 'k2', 'k3']) await join(u);
    for (const u of ['k1', 'k2', 'k3']) await waitAdmitted(u);
    await Promise.all(['k1', 'k2', 'k3'].map((u) => buy(u)));
    await doomed.crash();

    const rescuer = await startOrderWorker();
    try {
      for (const u of ['k1', 'k2', 'k3']) await waitState(u, 'success');
      assert.deepEqual((await orderUsers(infra)).sort(), ['k1', 'k2', 'k3', 'w1', 'w2']);
      assert.equal(await soldCount(infra), 5);
      assert.equal((await call(ports.orderHealth, 'GET', '/health')).body.status, 'ok');
    } finally {
      await shutdown([rescuer]);
    }
  });
});

describe('after Redis loses everything while every service keeps running', () => {
  let apps: App[] = [];
  before(async () => {
    await reset(infra, 5);
    apps = [
      await startOrderWorker(),
      await startWaitingRoom(ports.waitingRoom, sale(5)),
      await startPurchase(ports.purchase, sale(5)),
    ];
    await waitReady();
  });
  after(() => shutdown(apps));

  it('buyers recorded in Postgres still cannot buy again and stock is right', async () => {
    await join('keeper');
    await waitAdmitted('keeper');
    await buy('keeper');
    await waitState('keeper', 'success');

    await infra.redis.flushdb(); // everything: sale state and both streams
    await waitRebuilt(infra, 15_000);
    assert.equal(await infra.redis.get(saleKey('stock')), '4');
    assert.equal((await buy('keeper')).body.outcome, 'already_purchased');
    assert.equal((await purchaseState('keeper')).body.state, 'success');

    // and the system keeps working: a new buyer goes all the way through, over the recreated streams
    await join('newcomer');
    await waitAdmitted('newcomer');
    assert.equal((await buy('newcomer')).status, 202);
    await waitState('newcomer', 'success', 25_000);
    assert.deepEqual((await orderUsers(infra)).sort(), ['keeper', 'newcomer']);
  });
});
