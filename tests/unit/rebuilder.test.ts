// Rebuilder with an in-memory Redis side and Postgres side: when it rebuilds, what it writes, how it backs off.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { Rebuilder } from '../../apps/sale-service/src/purchase/rebuilder';
import type { BuyerSource } from '../../apps/sale-service/src/ports';
import { saleKeys } from '../../apps/sale-service/src/keys';

type Redis = ConstructorParameters<typeof Rebuilder>[0];

const keys = saleKeys('s');

// The few Redis commands the rebuild uses, kept in memory.
class FakeRedis {
  run = 'run-1';
  data = new Map<string, string>();
  buyers = new Set<string>();
  addBatches: string[][] = [];
  get ready() {
    return this.data.has(keys.ready);
  }
  get stock() {
    return this.data.has(keys.stock) ? Number(this.data.get(keys.stock)) : undefined;
  }
  async info() {
    return `run_id:${this.run}\r\n`;
  }
  async exists(key: string) {
    return this.data.has(key) ? 1 : 0;
  }
  async del(key: string) {
    this.data.delete(key);
  }
  async set(key: string, value: string | number, ...args: string[]) {
    if (args.includes('NX') && this.data.has(key)) return null;
    this.data.set(key, String(value));
    return 'OK';
  }
  async eval(_script: string, _n: number, key: string, token: string) {
    if (this.data.get(key) === token) this.data.delete(key);
  }
  async scard() {
    return this.buyers.size;
  }
  multi() {
    const chain = {
      sadd: (_key: string, ...users: string[]) => {
        this.addBatches.push(users);
        users.forEach((u) => this.buyers.add(u));
        return chain;
      },
      hset: () => chain,
      exec: async () => [],
    };
    return chain;
  }
}

class FakeSource implements BuyerSource {
  calls = 0;
  constructor(
    public users: string[] = [],
    public failWith?: Error,
  ) {}
  async buyers() {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return this.users;
  }
}

describe('Rebuilder', () => {
  let redis: FakeRedis;
  let logs: { level: string; msg?: string }[];
  const log = {
    info: (_: object, msg?: string) => void logs.push({ level: 'info', msg }),
    warn: (_: object, msg?: string) => void logs.push({ level: 'warn', msg }),
    error: (_: object, msg?: string) => void logs.push({ level: 'error', msg }),
  };
  const make = (source: BuyerSource, totalStock = 10) =>
    new Rebuilder(
      redis as unknown as Redis,
      keys,
      source,
      { saleId: 's', totalStock, runIdCheckMs: 1000 },
      log,
    );

  beforeEach(() => {
    redis = new FakeRedis();
    logs = [];
  });

  it('fills Redis from Postgres: buyers, stock left, then the ready marker', async () => {
    await make(new FakeSource(['ann', 'bob'])).check();
    assert.deepEqual([...redis.buyers], ['ann', 'bob']);
    assert.equal(redis.stock, 8);
    assert.equal(redis.ready, true);
  });

  it('writes buyers in chunks of 1000', async () => {
    const users = Array.from({ length: 2500 }, (_, i) => `u${i}`);
    await make(new FakeSource(users), 5000).check();
    assert.deepEqual(
      redis.addBatches.map((b) => b.length),
      [1000, 1000, 500],
    );
    assert.equal(redis.stock, 2500);
  });

  it('never removes a buyer Redis already has, and counts them against the stock', async () => {
    redis.buyers.add('not-in-postgres-yet');
    await make(new FakeSource(['ann'])).check();
    assert.ok(redis.buyers.has('not-in-postgres-yet'));
    assert.equal(redis.stock, 8);
  });

  it('never sets a negative stock', async () => {
    await make(new FakeSource(['a', 'b', 'c']), 2).check();
    assert.equal(redis.stock, 0);
  });

  it('does nothing while the run id is unchanged and the sale is ready', async () => {
    const source = new FakeSource(['ann']);
    const rebuilder = make(source);
    await rebuilder.check();
    await rebuilder.check();
    assert.equal(source.calls, 1);
  });

  it('rebuilds when the run id changes (Redis restarted or failed over)', async () => {
    const source = new FakeSource(['ann']);
    const rebuilder = make(source);
    await rebuilder.check();
    redis.run = 'run-2';
    await rebuilder.check();
    assert.equal(source.calls, 2);
  });

  it('rebuilds when the ready marker disappears under the same run id', async () => {
    const source = new FakeSource(['ann']);
    const rebuilder = make(source);
    await rebuilder.check();
    redis.data.delete(keys.ready);
    await rebuilder.check();
    assert.equal(source.calls, 2);
  });

  it('leaves the work to the instance holding the lock, and takes over once it is free', async () => {
    const source = new FakeSource(['ann']);
    const rebuilder = make(source);
    redis.data.set(keys.rebuildLock, 'someone-else');
    await rebuilder.check();
    assert.equal(source.calls, 0);
    assert.equal(redis.ready, false);

    redis.data.delete(keys.rebuildLock);
    await rebuilder.check();
    assert.equal(source.calls, 1);
    assert.equal(redis.ready, true);
  });

  it('keeps the sale not ready when Postgres fails, logs it, and waits before trying again', async () => {
    const source = new FakeSource([], new Error('pg down'));
    const rebuilder = make(source);
    await rebuilder.check();
    assert.equal(redis.ready, false);
    assert.deepEqual(
      logs.map((l) => l.level),
      ['error'],
    );

    await rebuilder.check();
    assert.equal(source.calls, 1, 'the second check falls inside the backoff');
  });

  it('only warns when the check itself fails', async () => {
    redis.info = async () => {
      throw new Error('redis down');
    };
    await make(new FakeSource()).check();
    assert.deepEqual(
      logs.map((l) => l.level),
      ['warn'],
    );
  });
});
