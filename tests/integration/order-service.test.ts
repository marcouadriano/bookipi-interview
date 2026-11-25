// Order Service against a real Redis and a real Postgres.
// The worker classes run in-process, so the tests can inject a logger and a broken database.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Redis } from 'ioredis';
import pg from 'pg';

import { createProcessor } from '../../apps/order-service/src/processor';
import { createOrderStore } from '../../apps/order-service/src/orders';
import { startHealthServer } from '../../apps/order-service/src/health';
import { OrderStreams } from '../../apps/order-service/src/streams';
import { Worker } from '../../apps/order-service/src/worker';
import { env, streams as keys } from './support/env';
import { call } from './support/http';
import {
  addOrder,
  connect,
  migrate,
  orderUsers,
  pendingCount,
  readStream,
  reset,
  resultsFor,
  soldCount,
  type Infra,
} from './support/infra';
import { sleep, until } from './support/util';

const GROUP = 'order-service';
const HEALTH_PORT = 4101;

let infra: Infra;
const stacks: Stack[] = [];

interface Stack {
  streams: OrderStreams;
  pool: pg.Pool;
  logs: { level: string; obj: Record<string, unknown>; msg?: string }[];
  stop(): Promise<void>;
}

// A worker wired the way index.ts wires it, with a logger we can read and short timings.
function startWorker(
  opts: {
    consumer?: string;
    maxDeliveries?: number;
    reclaimIdleMs?: number;
    reclaimIntervalMs?: number;
    databaseUrl?: string;
  } = {},
): Stack {
  const redis = new Redis(env.redisUrl);
  const blocking = redis.duplicate();
  const pool = new pg.Pool({
    connectionString: opts.databaseUrl ?? env.databaseUrl,
    connectionTimeoutMillis: 2000,
  });

  const logs: Stack['logs'] = [];
  const log = (level: string) => (obj: object, msg?: string) =>
    void logs.push({ level, obj: obj as Record<string, unknown>, msg });
  const logger = { info: log('info'), warn: log('warn'), error: log('error') };

  const streams = new OrderStreams(redis, blocking, {
    consumerName: opts.consumer ?? 'w1',
    batchSize: 100,
    blockMs: 200,
    reclaimIdleMs: opts.reclaimIdleMs ?? 500,
  });
  const processor = createProcessor(
    streams,
    createOrderStore(pool),
    { saleId: env.saleId, maxDeliveries: opts.maxDeliveries ?? 3 },
    logger,
  );
  const worker = new Worker(
    streams,
    processor,
    { reclaimIntervalMs: opts.reclaimIntervalMs ?? 200 },
    logger,
  );

  const running = worker.run();

  const stack: Stack = {
    streams,
    pool,
    logs,
    async stop() {
      worker.stop();
      await running;
      await Promise.all([redis.quit(), blocking.quit(), pool.end()]);
    },
  };
  stacks.push(stack);
  return stack;
}

// Creates the consumer group, so a test can read messages as a consumer that then "crashes".
async function createGroup() {
  await infra.redis.xgroup('CREATE', keys.orders, GROUP, '0', 'MKSTREAM').catch((e) => {
    if (!String(e).includes('BUSYGROUP')) throw e;
  });
}

// Reads every new message as `consumer` and never acknowledges: a worker that crashed mid-batch.
const crashedRead = (consumer: string) =>
  infra.redis.call(
    'XREADGROUP',
    'GROUP',
    GROUP,
    consumer,
    'COUNT',
    100,
    'STREAMS',
    keys.orders,
    '>',
  );

const statuses = async (userId: string) => (await resultsFor(infra, userId)).map((r) => r.status);

before(async () => {
  infra = await connect();
});

beforeEach(async () => {
  await reset(infra, 3);
});

// A test that fails before its own `w.stop()` must not leave a worker running for the next test.
// Stopping a worker twice is harmless: the second stop fails and is ignored.
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.stop().catch(() => undefined);
});

after(async () => {
  await infra.close();
});

describe('recording orders', () => {
  it('writes each order to Postgres, counts it, publishes `recorded` and acknowledges', async () => {
    const w = startWorker();
    const [a, b] = [await addOrder(infra, 'u1'), await addOrder(infra, 'u2')];
    await until('both orders recorded', async () => (await orderUsers(infra)).length === 2);
    await until(
      'both results published',
      async () => (await readStream(infra, keys.results)).length === 2,
    );

    assert.deepEqual(await orderUsers(infra), ['u1', 'u2']);
    assert.equal(await soldCount(infra), 2);
    const results = await readStream(infra, keys.results);
    assert.deepEqual(
      results.map((r) => [r.userId, r.status, r.orderMessageId]),
      [
        ['u1', 'recorded', a],
        ['u2', 'recorded', b],
      ],
    );
    assert.ok(
      results.every((r) => r.saleId === env.saleId && !r.reason && !Number.isNaN(Date.parse(r.at))),
    );
    await until('acknowledged', async () => (await pendingCount(infra, keys.orders, GROUP)) === 0);
    await w.stop();
  });

  it('keeps the purchase time and the message id on the row', async () => {
    const w = startWorker();
    const id = await addOrder(infra, 'u1');
    await until('recorded', async () => (await orderUsers(infra)).length === 1);
    const row = (
      await infra.db.query('SELECT order_message_id, reserved_at, created_at FROM orders')
    ).rows[0];
    assert.equal(row.order_message_id, id);
    assert.ok(Math.abs(row.reserved_at.getTime() - Date.now()) < 60_000);
    await w.stop();
  });

  it('ignores a second order from the same user, still publishes `recorded`, and does not count it twice', async () => {
    const w = startWorker();
    await addOrder(infra, 'u1');
    await until('first recorded', async () => (await orderUsers(infra)).length === 1);
    await addOrder(infra, 'u1'); // new message id, same user
    await until('second result', async () => (await resultsFor(infra, 'u1')).length === 2);

    assert.deepEqual(await orderUsers(infra), ['u1']);
    assert.equal(await soldCount(infra), 1);
    assert.deepEqual(await statuses('u1'), ['recorded', 'recorded']);
    await w.stop();
  });

  it('handles a large burst across several batches without losing or duplicating anything', async () => {
    await reset(infra, 500);
    const w = startWorker();
    const users = Array.from({ length: 250 }, (_, i) => `burst${i}`);
    await Promise.all(users.map((u) => addOrder(infra, u)));
    await until('all 250 recorded', async () => (await orderUsers(infra)).length === 250, 30_000);
    await until(
      'all acknowledged',
      async () => (await pendingCount(infra, keys.orders, GROUP)) === 0,
    );

    assert.equal(new Set(await orderUsers(infra)).size, 250);
    assert.equal(await soldCount(infra), 250);
    assert.equal(
      (await readStream(infra, keys.results)).filter((r) => r.status === 'recorded').length,
      250,
    );
    await w.stop();
  });

  it('splits the work between several workers: every order once, none lost', async () => {
    await reset(infra, 500);
    const workers = [
      startWorker({ consumer: 'a' }),
      startWorker({ consumer: 'b' }),
      startWorker({ consumer: 'c' }),
    ];
    for (let i = 0; i < 90; i++) await addOrder(infra, `m${i}`);
    await until('all 90 recorded', async () => (await orderUsers(infra)).length === 90, 30_000);
    await until(
      'all acknowledged',
      async () => (await pendingCount(infra, keys.orders, GROUP)) === 0,
    );

    assert.equal(new Set(await orderUsers(infra)).size, 90);
    assert.equal(await soldCount(infra), 90);
    const recorded = (await readStream(infra, keys.results)).filter((r) => r.status === 'recorded');
    assert.equal(new Set(recorded.map((r) => r.userId)).size, 90);
    await Promise.all(workers.map((w) => w.stop()));
  });
});

describe('messages that cannot be recorded', () => {
  it('moves malformed messages to the failed stream and acknowledges them', async () => {
    const w = startWorker();
    await infra.redis.xadd(
      keys.orders,
      '*',
      'saleId',
      env.saleId,
      'userId',
      'bad',
      'reservedAtMs',
      'not-a-date',
    );
    await infra.redis.xadd(keys.orders, '*', 'foo', 'bar');
    await until(
      'both in the failed stream',
      async () => (await readStream(infra, keys.failed)).length === 2,
    );

    const failed = await readStream(infra, keys.failed);
    assert.ok(
      failed.every(
        (f) =>
          f.reason === 'invalid_message' &&
          f.deliveries === '1' &&
          !Number.isNaN(Date.parse(f.failedAt)),
      ),
    );
    assert.equal(failed[0].userId, 'bad'); // the original fields are kept
    assert.deepEqual(
      (await readStream(infra, keys.results)).map((r) => [r.userId, r.status, r.reason]),
      [['bad', 'failed', 'invalid_message']],
    );
    await until('acknowledged', async () => (await pendingCount(infra, keys.orders, GROUP)) === 0);
    assert.deepEqual(await orderUsers(infra), []);
    await w.stop();
  });

  it('fails a message delivered more than MAX_DELIVERIES times', async () => {
    await createGroup();
    const doomed = await addOrder(infra, 'doomed');
    const last = await addOrder(infra, 'last');
    await crashedRead('ghost'); // delivery 1 for both
    // `doomed` gets two more deliveries (3 = MAX_DELIVERIES); the worker's reclaim then makes it 4.
    for (let i = 0; i < 2; i++)
      await infra.redis.call('XCLAIM', keys.orders, GROUP, 'ghost', 0, doomed);
    await infra.redis.call('XCLAIM', keys.orders, GROUP, 'ghost', 0, last); // `last` is at 2, reclaim makes it 3 = MAX

    await sleep(600);
    const w = startWorker({ maxDeliveries: 3, reclaimIdleMs: 500 });
    await until(
      'both settled',
      async () =>
        (await resultsFor(infra, 'doomed')).length === 1 &&
        (await resultsFor(infra, 'last')).length === 1,
    );

    const failed = await readStream(infra, keys.failed);
    assert.deepEqual(
      failed.map((f) => [f.userId, f.reason]),
      [['doomed', 'processing_error']],
    );
    assert.ok(Number(failed[0].deliveries) > 3);
    assert.deepEqual(await statuses('doomed'), ['failed']);
    assert.deepEqual(await statuses('last'), ['recorded']);
    assert.deepEqual(await orderUsers(infra), ['last']);
    await until('acknowledged', async () => (await pendingCount(infra, keys.orders, GROUP)) === 0);
    await w.stop();
  });
});

describe('stock', () => {
  it('when Postgres runs out, records the earliest purchases and fails the rest', async () => {
    await reset(infra, 3);
    await infra.db.query('UPDATE sales SET sold = 2 WHERE id = $1', [env.saleId]); // one unit left
    // Written before the worker starts, so they arrive as one batch (which exercises the fallback).
    // Stream ids always increase, so `first` has the lowest id: it is the earliest purchase.
    await addOrder(infra, 'first');
    await addOrder(infra, 'second');
    await addOrder(infra, 'third');
    const w = startWorker();
    await until('three results', async () => (await readStream(infra, keys.results)).length === 3);

    assert.deepEqual(await orderUsers(infra), ['first']);
    assert.equal(await soldCount(infra), 3);
    const byUser = Object.fromEntries(
      (await readStream(infra, keys.results)).map((r) => [r.userId, r]),
    );
    assert.equal(byUser.first.status, 'recorded');
    assert.deepEqual([byUser.second.status, byUser.second.reason], ['failed', 'sold_out']);
    assert.deepEqual([byUser.third.status, byUser.third.reason], ['failed', 'sold_out']);
    assert.deepEqual(
      (await readStream(infra, keys.failed)).map((f) => f.reason),
      ['sold_out', 'sold_out'],
    );
    assert.ok(
      w.logs.some((l) => l.level === 'error' && l.obj.alert === 'INTEGRITY_ALERT'),
      'INTEGRITY_ALERT was not logged',
    );

    await until('acknowledged', async () => (await pendingCount(infra, keys.orders, GROUP)) === 0);
    await w.stop();
  });

  it('never lets `sold` pass `total_stock`: the database refuses it too', async () => {
    await assert.rejects(
      infra.db.query('UPDATE sales SET sold = total_stock + 1 WHERE id = $1', [env.saleId]),
      (err: { code?: string }) => err.code === '23514', // check_violation
    );
  });

  it('writes nothing for a batch that does not fit, because the whole batch rolls back first', async () => {
    await reset(infra, 2);
    await infra.db.query('UPDATE sales SET sold = 2 WHERE id = $1', [env.saleId]); // sold out already
    await addOrder(infra, 'x1');
    await addOrder(infra, 'x2');
    const w = startWorker();
    await until('both failed', async () => (await readStream(infra, keys.failed)).length === 2);
    assert.deepEqual(await orderUsers(infra), []);
    assert.equal(await soldCount(infra), 2);
    await w.stop();
  });
});

describe('crashes and outages', () => {
  it('reclaims messages that a crashed worker left behind and records them', async () => {
    await createGroup();
    await addOrder(infra, 'c1');
    await addOrder(infra, 'c2');
    await crashedRead('crashed-worker');
    assert.equal(await pendingCount(infra, keys.orders, GROUP), 2);

    await sleep(600);
    const w = startWorker({ reclaimIdleMs: 500 });
    await until('both recorded', async () => (await orderUsers(infra)).length === 2);
    assert.deepEqual(await orderUsers(infra), ['c1', 'c2']);
    await until('acknowledged', async () => (await pendingCount(infra, keys.orders, GROUP)) === 0);
    await w.stop();
  });

  it('after a crash between commit and publish, publishes `recorded` and counts nothing twice', async () => {
    await createGroup();
    const id = await addOrder(infra, 'stored');
    await crashedRead('crashed-worker');
    // What the crashed worker had already committed:
    await infra.db.query(
      "INSERT INTO orders (sale_id, user_id, reserved_at, order_message_id) VALUES ($1, 'stored', now(), $2)",
      [env.saleId, id],
    );
    await infra.db.query('UPDATE sales SET sold = 1 WHERE id = $1', [env.saleId]);

    await sleep(600);
    const w = startWorker({ reclaimIdleMs: 500 });
    await until('result published', async () => (await resultsFor(infra, 'stored')).length === 1);
    assert.deepEqual(await statuses('stored'), ['recorded']);
    assert.equal(await soldCount(infra), 1);
    assert.deepEqual(await orderUsers(infra), ['stored']);
    await w.stop();
  });

  it('with Postgres unreachable, acknowledges nothing, then a healthy worker recovers', async () => {
    const bad = startWorker({
      consumer: 'bad',
      databaseUrl: env.databaseUrl.replace('postgres:postgres@', 'postgres:wrong@'),
      reclaimIntervalMs: 60_000,
      maxDeliveries: 10,
    });
    await addOrder(infra, 'p1');
    await until('the failure is logged', () =>
      bad.logs.some((l) => l.msg === 'batch failed; not acknowledged'),
    );

    assert.equal(await pendingCount(infra, keys.orders, GROUP), 1);
    assert.equal((await readStream(infra, keys.results)).length, 0);
    assert.deepEqual(await orderUsers(infra), []);
    await bad.stop();

    await sleep(600);
    const good = startWorker({
      consumer: 'good',
      reclaimIdleMs: 500,
      maxDeliveries: 10,
    });
    await until('recovered', async () => (await orderUsers(infra)).length === 1);
    assert.deepEqual(await statuses('p1'), ['recorded']);
    await until('acknowledged', async () => (await pendingCount(infra, keys.orders, GROUP)) === 0);
    await good.stop();
  });

  it('after Redis loses its data (the consumer group is gone): creates the group again and keeps working', async () => {
    const w = startWorker();
    await addOrder(infra, 'before');
    await until('first recorded', async () => (await orderUsers(infra)).length === 1);

    await infra.redis.flushdb(); // stream and group are gone
    await addOrder(infra, 'after');
    await until('second recorded', async () => (await orderUsers(infra)).length === 2, 20_000);
    assert.deepEqual(await orderUsers(infra), ['before', 'after']);
    assert.ok(w.logs.some((l) => l.level === 'error' && /NOGROUP/.test(String(l.obj.err))));
    await w.stop();
  });

  it('stops cleanly: finishes the batch it is on and leaves nothing unacknowledged', async () => {
    const w = startWorker();
    for (let i = 0; i < 30; i++) await addOrder(infra, `s${i}`);
    await until('some recorded', async () => (await orderUsers(infra)).length > 0);
    await w.stop();
    assert.equal(await pendingCount(infra, keys.orders, GROUP), 0);
    assert.equal((await orderUsers(infra)).length, await soldCount(infra)); // rows and counter agree
  });
});

describe('health endpoint', () => {
  async function health(pool: pg.Pool) {
    const redis = new Redis(env.redisUrl);
    const server = startHealthServer(HEALTH_PORT, {
      counts: () =>
        new OrderStreams(redis, redis, {
          consumerName: 'h',
          batchSize: 1,
          blockMs: 1,
          reclaimIdleMs: 1,
        }).counts(),
      pingDatabase: () => pool.query('SELECT 1'),
    });

    try {
      return await call(HEALTH_PORT, 'GET', '/health');
    } finally {
      await new Promise((r) => server.close(r));
      redis.disconnect();
    }
  }

  it('reports ok, the pending count and the failed-orders count', async () => {
    await createGroup();
    await infra.redis.xadd(keys.failed, '*', 'userId', 'x', 'reason', 'sold_out');
    await addOrder(infra, 'waiting');
    await crashedRead('someone');
    const pool = new pg.Pool({ connectionString: env.databaseUrl });
    const res = await health(pool);
    await pool.end();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      status: 'ok',
      redis: 'up',
      postgres: 'up',
      pendingMessages: 1,
      failedOrders: 1,
    });
  });

  it('answers 503 degraded when Postgres is unreachable', async () => {
    await createGroup();
    const pool = new pg.Pool({
      connectionString: env.databaseUrl.replace('postgres:postgres@', 'postgres:wrong@'),
    });
    const res = await health(pool);
    await pool.end();
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'degraded');
    assert.equal(res.body.postgres, 'down');
    assert.equal(res.body.redis, 'up');
  });
});

describe('migration and the read-only role', () => {
  it('can be run again: tables, the seeded sale and the view stay as they are', async () => {
    await migrate(3);
    await migrate(3);
    assert.deepEqual((await infra.db.query('SELECT id, total_stock, sold FROM sales')).rows, [
      { id: env.saleId, total_stock: 3, sold: 0 },
    ]);
  });

  it('lets `sale_reader` read `sale_buyers` but nothing else', async () => {
    await infra.db.query(
      "INSERT INTO orders (sale_id, user_id, reserved_at, order_message_id) VALUES ($1, 'viewer', now(), '1-1')",
      [env.saleId],
    );
    const reader = new pg.Pool({ connectionString: env.readerUrl });

    try {
      assert.deepEqual((await reader.query('SELECT sale_id, user_id FROM sale_buyers')).rows, [
        { sale_id: env.saleId, user_id: 'viewer' },
      ]);
      await assert.rejects(
        reader.query('SELECT * FROM orders'),
        (e: { code?: string }) => e.code === '42501',
      ); // insufficient_privilege
      await assert.rejects(
        reader.query("INSERT INTO sales (id, total_stock) VALUES ('x', 1)"),
        (e: { code?: string }) => e.code === '42501',
      );
    } finally {
      await reader.end();
    }
  });
});
