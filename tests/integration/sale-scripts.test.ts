// The Lua scripts behind joining, the line and buying, against a real Redis. Each test writes the
// Redis state it needs by hand, so every rule is checked on its own and not through the apps.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { fieldsToObject, ORDERS_STREAM } from '@flashsale/shared/node';

import { saleKeys } from '../../apps/sale-service/src/keys';
import { RedisLine } from '../../apps/sale-service/src/redis/line';
import { RedisPurchases } from '../../apps/sale-service/src/redis/purchases';
import { registerScripts } from '../../apps/sale-service/src/redis/scripts';
import { env } from './support/env';
import { connect, type Infra } from './support/infra';

const HOUR = 3600_000;
const WINDOW_MS = 10_000;
const RAN_OUT_MS = WINDOW_MS + 1000;

const keys = saleKeys(env.saleId);

const saleWindow = {
  active: () => ({ saleStartMs: Date.now() - HOUR, saleEndMs: Date.now() + HOUR }),
  upcoming: () => ({ saleStartMs: Date.now() + HOUR, saleEndMs: Date.now() + 2 * HOUR }),
  ended: () => ({ saleStartMs: Date.now() - 2 * HOUR, saleEndMs: Date.now() - HOUR }),
};

let infra: Infra;
let redis: ReturnType<typeof registerScripts>;

const line = (sale = saleWindow.active()) =>
  new RedisLine(redis, keys, {
    ...sale,
    admitBatchSize: 2,
    admitIntervalMs: 60_000,
    admitWindowMs: WINDOW_MS,
  });

const purchases = (sale = saleWindow.active()) =>
  new RedisPurchases(redis, keys, { saleId: env.saleId, ...sale, admitWindowMs: WINDOW_MS });

const open = (stock: number) => redis.mset(keys.ready, '1', keys.stock, stock);

// A user whose ticket was reached by a pop `poppedMsAgo` ago.
async function admit(user: string, ticket = 1, poppedMsAgo = 0) {
  await redis.hset(keys.tickets, user, ticket);
  await redis.zadd(keys.pops, ticket, Date.now() - poppedMsAgo);
}

before(async () => {
  infra = await connect();
  redis = registerScripts(infra.redis);
});

after(() => infra.close());

beforeEach(() => redis.flushdb());

describe('buying', () => {
  it('answers unavailable until the ready marker exists', async () => {
    await redis.set(keys.stock, 3);
    await admit('ann');

    assert.deepEqual(await purchases().purchase('ann'), { kind: 'unavailable' });
  });

  it('refuses outside the sale window, and says on which side', async () => {
    await open(3);
    await admit('ann');

    assert.deepEqual(await purchases(saleWindow.upcoming()).purchase('ann'), {
      kind: 'sale_not_active',
      saleStatus: 'upcoming',
    });
    assert.deepEqual(await purchases(saleWindow.ended()).purchase('ann'), {
      kind: 'sale_not_active',
      saleStatus: 'ended',
    });
  });

  it('refuses a user who already bought, even while still admitted', async () => {
    await open(3);
    await admit('ann');
    await redis.sadd(keys.buyers, 'ann');

    assert.deepEqual(await purchases().purchase('ann'), { kind: 'already_purchased' });
  });

  it('refuses a user who is not admitted: no ticket, still waiting, or window run out', async () => {
    await open(3);
    await redis.hset(keys.tickets, 'waiting', 5); // no pop has reached ticket 5 yet
    await admit('late', 1, RAN_OUT_MS);

    for (const user of ['nobody', 'waiting', 'late']) {
      assert.deepEqual(await purchases().purchase(user), { kind: 'not_admitted' }, user);
    }
    assert.equal(await redis.get(keys.stock), '3');
    assert.equal(await redis.scard(keys.buyers), 0);
  });

  it('checks admission before stock: nobody learns the stock is gone without being admitted', async () => {
    await open(0);

    assert.deepEqual(await purchases().purchase('nobody'), { kind: 'not_admitted' });
  });

  it('refuses an admitted user when the stock is gone, or was never set', async () => {
    await open(0);
    await admit('ann');
    assert.deepEqual(await purchases().purchase('ann'), { kind: 'sold_out' });

    await redis.del(keys.stock);
    assert.deepEqual(await purchases().purchase('ann'), { kind: 'sold_out' });
  });

  it('accepts an admitted user: one unit taken, state processing, order queued', async () => {
    await open(3);
    await admit('ann');

    assert.deepEqual(await purchases().purchase('ann'), { kind: 'accepted' });

    assert.equal(await redis.get(keys.stock), '2');
    assert.equal(await redis.sismember(keys.buyers, 'ann'), 1);
    assert.equal(await redis.hget(keys.purchases, 'ann'), 'processing');

    const orders = await redis.xrange(ORDERS_STREAM, '-', '+');
    assert.equal(orders.length, 1);
    const order = fieldsToObject(orders[0][1]);
    assert.deepEqual([order.saleId, order.userId], [env.saleId, 'ann']);
    assert.match(order.reservedAtMs, /^\d{13}$/);
  });

  it('accepts exactly the stock when many admitted users buy at once', async () => {
    await open(5);
    const users = Array.from({ length: 20 }, (_, i) => `rush${i}`);
    for (const [i, user] of users.entries()) await redis.hset(keys.tickets, user, i + 1);
    await redis.zadd(keys.pops, 100, Date.now()); // one pop that reached every ticket

    const results = await Promise.all(users.map((u) => purchases().purchase(u)));

    assert.equal(results.filter((r) => r.kind === 'accepted').length, 5);
    assert.equal(results.filter((r) => r.kind === 'sold_out').length, 15);
    assert.equal(await redis.get(keys.stock), '0');
    assert.equal(await redis.scard(keys.buyers), 5);
    assert.equal(await redis.xlen(ORDERS_STREAM), 5);
  });
});

describe('joining', () => {
  it('answers unavailable until the ready marker exists', async () => {
    assert.deepEqual(await line().join('ann'), { kind: 'unavailable' });
  });

  it('refuses a user who already bought', async () => {
    await open(3);
    await redis.sadd(keys.buyers, 'ann');

    assert.deepEqual(await line().join('ann'), { kind: 'already_purchased' });
  });

  it('refuses outside the sale window and when the stock is gone', async () => {
    await open(3);
    assert.deepEqual(await line(saleWindow.upcoming()).join('ann'), { kind: 'sale_not_active' });
    assert.deepEqual(await line(saleWindow.ended()).join('ann'), { kind: 'sale_not_active' });

    await redis.set(keys.stock, 0);
    assert.deepEqual(await line().join('ann'), { kind: 'sale_not_active' });
  });

  it('hands out tickets in order, and joining again keeps the place', async () => {
    await open(3);

    await line().join('ann');
    await line().join('bob');
    const again = await line().join('ann');

    assert.deepEqual(again, { kind: 'queued', status: { userId: 'ann', state: 'waiting' } });
    assert.equal(await redis.hget(keys.tickets, 'ann'), '1');
    assert.equal(await redis.hget(keys.tickets, 'bob'), '2');
    assert.equal(await redis.get(keys.last), '2');
  });

  it('shows an admitted user the end of their buying window', async () => {
    await open(3);
    await admit('ann', 1, 2000);

    const joined = await line().join('ann');

    assert.equal(joined.kind, 'queued');
    const until = Date.parse(
      (joined as { status: { admittedUntil: string } }).status.admittedUntil,
    );
    assert.ok(Math.abs(until - (Date.now() + WINDOW_MS - 2000)) < 1000);
  });

  it('sends a user whose window ran out to the back of the line', async () => {
    await open(3);
    await admit('late', 1, RAN_OUT_MS);
    await redis.set(keys.last, 4);

    const joined = await line().join('late');

    assert.deepEqual(joined, { kind: 'queued', status: { userId: 'late', state: 'waiting' } });
    assert.equal(await redis.hget(keys.tickets, 'late'), '5');
  });
});

describe('place in line', () => {
  it('knows nobody who never joined', async () => {
    assert.equal(await line().status('nobody'), null);
  });

  it('tells waiting, admitted and expired apart', async () => {
    await redis.hset(keys.tickets, 'waiting', 5);
    await admit('admitted', 1, 1000);
    await admit('expired', 2, RAN_OUT_MS);

    assert.deepEqual(await line().status('waiting'), { userId: 'waiting', state: 'waiting' });
    assert.equal((await line().status('admitted'))?.state, 'admitted');
    assert.equal((await line().status('expired'))?.state, 'expired');
  });
});

describe('admitting from the front', () => {
  beforeEach(async () => {
    await open(3);
    await redis.set(keys.last, 3);
  });

  it('does nothing before the ready marker, outside the window, or with no stock', async () => {
    await redis.del(keys.ready);
    assert.equal(await line().pop(), 0);

    await redis.set(keys.ready, '1');
    assert.equal(await line(saleWindow.upcoming()).pop(), 0);
    assert.equal(await line(saleWindow.ended()).pop(), 0);

    await redis.set(keys.stock, 0);
    assert.equal(await line().pop(), 0);

    assert.equal(await redis.get(keys.serving), null);
  });

  it('admits up to the batch size and never past the last ticket', async () => {
    assert.equal(await line().pop(), 2);
    await redis.del(keys.lastTick); // the next tick
    assert.equal(await line().pop(), 1);
    await redis.del(keys.lastTick);
    assert.equal(await line().pop(), 0);

    assert.equal(await redis.get(keys.serving), '3');
  });

  it('pops each tick only once', async () => {
    assert.equal(await line().pop(), 2);
    assert.equal(await line().pop(), 0);
    assert.equal(await redis.get(keys.serving), '2');
  });

  it('records each pop: the score is how far the line moved, the member is the time', async () => {
    const before = Date.now();
    await line().pop();

    const [member, score] = await redis.zrange(keys.pops, 0, -1, 'WITHSCORES');
    assert.equal(score, '2');
    assert.ok(Number(member) >= before && Number(member) <= Date.now());
  });
});
