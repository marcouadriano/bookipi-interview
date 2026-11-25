import type { Redis } from 'ioredis';

import type { RateLimiter } from '../ports';

// Fixed-window counters in Redis.
export class RedisRateLimiter implements RateLimiter {
  constructor(private redis: Redis) {}

  async hit(key: string, max: number, windowMs: number) {
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const bucketKey = `${key}:${bucket}`;
    const replies = await this.redis
      .multi()
      .incr(bucketKey)
      .pexpire(bucketKey, windowMs, 'NX')
      .exec();
    // If the INCR itself errored, count is 0 and the request is let through. That is deliberate:
    // purchase safety does not depend on this limit. A Redis outage makes exec() throw instead.
    const count = Number(replies?.[0]?.[1] ?? 0);
    return {
      allowed: count <= max,
      retryAfterSec: Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000)),
    };
  }
}
