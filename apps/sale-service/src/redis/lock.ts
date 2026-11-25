import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const RELEASE_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

// A Redis lock with an expiry. Only the holder that took it can release it.
export class RedisLock {
  constructor(
    private redis: Redis,
    private key: string,
    private ttlMs: number,
  ) {}

  // Runs `work` if the lock is free and returns true. Returns
  // false, without running it, when someone else holds it.
  async run(work: () => Promise<void>): Promise<boolean> {
    const token = randomUUID();
    if (!(await this.redis.set(this.key, token, 'PX', this.ttlMs, 'NX'))) return false;
    try {
      await work();
      return true;
    } finally {
      await this.redis.eval(RELEASE_IF_OWNER, 1, this.key, token);
    }
  }
}
