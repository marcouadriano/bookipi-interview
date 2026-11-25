// RedisLock against a tiny in-memory stand-in for the two Redis commands it uses.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RedisLock } from '../../apps/sale-service/src/redis/lock';

type Redis = ConstructorParameters<typeof RedisLock>[0];

function fakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    async set(key: string, value: string, _px: string, _ttl: number, _nx: string) {
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async eval(_script: string, _n: number, key: string, token: string) {
      if (store.get(key) !== token) return 0;
      store.delete(key);
      return 1;
    },
  };
  return { store, redis: redis as unknown as Redis };
}

describe('RedisLock', () => {
  it('runs the work and releases the lock', async () => {
    const { store, redis } = fakeRedis();
    let ran = false;
    assert.equal(await new RedisLock(redis, 'k', 1000).run(async () => void (ran = true)), true);
    assert.equal(ran, true);
    assert.equal(store.has('k'), false);
  });

  it('skips the work while someone else holds the lock, and leaves their lock alone', async () => {
    const { store, redis } = fakeRedis();
    store.set('k', 'someone-else');
    let ran = false;
    assert.equal(await new RedisLock(redis, 'k', 1000).run(async () => void (ran = true)), false);
    assert.equal(ran, false);
    assert.equal(store.get('k'), 'someone-else');
  });

  it('releases the lock and rethrows when the work fails', async () => {
    const { store, redis } = fakeRedis();
    await assert.rejects(
      new RedisLock(redis, 'k', 1000).run(async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(store.has('k'), false);
  });

  it('can be taken again after release', async () => {
    const { redis } = fakeRedis();
    const lock = new RedisLock(redis, 'k', 1000);
    assert.equal(await lock.run(async () => {}), true);
    assert.equal(await lock.run(async () => {}), true);
  });
});
