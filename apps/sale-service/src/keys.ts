import type { Redis } from 'ioredis';

// Redis key names, shared by both apps. The `{saleId}` braces are a hash tag, so every key
// of one sale lands in the same slot if Redis is ever run in cluster mode.

export function saleKeys(saleId: string) {
  const k = (name: string) => `sale:{${saleId}}:${name}`;
  return {
    ready: k('ready'),
    stock: k('stock'),
    buyers: k('buyers'), // set of user ids
    purchases: k('purchases'), // hash: user id -> processing | success | failed:<reason>
    tickets: k('tickets'), // hash: user id -> ticket number
    last: k('last'), // last ticket handed out
    serving: k('serving'), // tickets up to this number have been popped
    lastTick: k('last-tick'), // last pop tick that was claimed
    pops: k('pops'), // sorted set: score = serving after the pop, member = pop time (ms)
    rebuildLock: k('rebuild-lock'),
  };
}

export type SaleKeys = ReturnType<typeof saleKeys>;

export const rateLimitKey = (scope: 'ip' | 'user', id: string) => `ratelimit:${scope}:${id}`;

// The ready marker is set once Redis has been filled from
// Postgres; until then joining and purchases answer 503.
export const isSaleReady = async (redis: Redis, keys: SaleKeys): Promise<boolean> =>
  (await redis.exists(keys.ready)) === 1;
