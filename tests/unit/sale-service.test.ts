// Sale Service pieces that need no Redis or HTTP server: rate-limit middleware, config, keys, user IDs.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { normalizeUserId } from '@flashsale/shared';

import { loadConfig } from '../../apps/sale-service/src/config';
import { createUserLimit, ipRateLimit } from '../../apps/sale-service/src/http/rateLimit';
import { requireUserId } from '../../apps/sale-service/src/http/errors';
import { rateLimitKey, saleKeys } from '../../apps/sale-service/src/keys';
import type { RateLimiter } from '../../apps/sale-service/src/ports';

type Res = Parameters<typeof requireUserId>[1];
type Hit = { key: string; max: number; windowMs: number };

function fakeLimiter(allowed: boolean, retryAfterSec = 7) {
  const hits: Hit[] = [];
  const limiter = {
    async hit(key: string, max: number, windowMs: number) {
      hits.push({ key, max, windowMs });
      return { allowed, retryAfterSec };
    },
  } as RateLimiter;
  return { limiter, hits };
}

function fakeRes() {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const ipConfig = {
  rateLimitIpEnabled: true,
  rateLimitIpMax: 100,
  rateLimitIpWindowMs: 10_000,
};

describe('ipRateLimit', () => {
  const run = async (
    limiter: RateLimiter,
    config: typeof ipConfig,
    req: { path: string; ip?: string },
  ) => {
    const res = fakeRes();
    let nexted = false;
    await ipRateLimit(limiter, config)(req as never, res as never, () => void (nexted = true));
    return { res, nexted };
  };

  it('lets the request through when under the limit, counting it against the caller IP', async () => {
    const { limiter, hits } = fakeLimiter(true);
    const { nexted, res } = await run(limiter, ipConfig, {
      path: '/api/sale',
      ip: '1.2.3.4',
    });
    assert.equal(nexted, true);
    assert.equal(res.statusCode, 0);
    assert.deepEqual(hits, [{ key: 'ratelimit:ip:1.2.3.4', max: 100, windowMs: 10_000 }]);
  });

  it('answers 429 with Retry-After and does not continue when over the limit', async () => {
    const { limiter } = fakeLimiter(false, 7);
    const { nexted, res } = await run(limiter, ipConfig, {
      path: '/api/sale',
      ip: '1.2.3.4',
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['Retry-After'], '7');
    assert.equal((res.body as { error: { code: string } }).error.code, 'rate_limited');
  });

  it('never limits /health', async () => {
    const { limiter, hits } = fakeLimiter(false);
    const { nexted } = await run(limiter, ipConfig, {
      path: '/health',
      ip: '1.2.3.4',
    });
    assert.equal(nexted, true);
    assert.equal(hits.length, 0);
  });

  it('does nothing when RATE_LIMIT_IP_ENABLED=false', async () => {
    const { limiter, hits } = fakeLimiter(false);
    const { nexted } = await run(
      limiter,
      { ...ipConfig, rateLimitIpEnabled: false },
      { path: '/api/sale', ip: '1.2.3.4' },
    );
    assert.equal(nexted, true);
    assert.equal(hits.length, 0);
  });

  it('uses one shared bucket when the IP is unknown', async () => {
    const { limiter, hits } = fakeLimiter(true);
    await run(limiter, ipConfig, { path: '/api/sale' });
    assert.equal(hits[0].key, 'ratelimit:ip:unknown');
  });
});

describe('createUserLimit', () => {
  const userConfig = { rateLimitUserMax: 5, rateLimitUserWindowMs: 10_000 };

  it('returns false and sends nothing when under the limit', async () => {
    const { limiter, hits } = fakeLimiter(true);
    const res = fakeRes();
    assert.equal(await createUserLimit(limiter, userConfig)(res as never, 'ann'), false);
    assert.equal(res.statusCode, 0);
    assert.deepEqual(hits, [{ key: 'ratelimit:user:ann', max: 5, windowMs: 10_000 }]);
  });

  it('returns true after sending 429 with Retry-After when over the limit', async () => {
    const { limiter } = fakeLimiter(false, 3);
    const res = fakeRes();
    assert.equal(await createUserLimit(limiter, userConfig)(res as never, 'ann'), true);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['Retry-After'], '3');
  });
});

describe('loadConfig', () => {
  const names = [
    'SALE_START',
    'SALE_END',
    'TOTAL_STOCK',
    'RATE_LIMIT_IP_ENABLED',
    'ADMIT_BATCH_SIZE',
    'ADMIT_INTERVAL_MS',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names) delete process.env[n];
    process.env.SALE_START = '2026-01-01T00:00:00Z';
    process.env.SALE_END = '2026-01-01T01:00:00Z';
  });
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('parses the sale window and applies defaults', () => {
    const c = loadConfig();
    assert.equal(c.saleStartMs, Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(c.saleEndMs, Date.parse('2026-01-01T01:00:00Z'));
    assert.equal(c.totalStock, 100);
    assert.equal(c.rateLimitIpEnabled, true);
  });

  it('reads overrides from the environment', () => {
    process.env.TOTAL_STOCK = '10000';
    process.env.RATE_LIMIT_IP_ENABLED = 'false';
    process.env.ADMIT_BATCH_SIZE = '7';
    const c = loadConfig();
    assert.deepEqual([c.totalStock, c.rateLimitIpEnabled, c.admitBatchSize], [10000, false, 7]);
  });

  it('rejects admit settings below 1', () => {
    process.env.ADMIT_INTERVAL_MS = '0';
    assert.throws(() => loadConfig(), /ADMIT_INTERVAL_MS must be at least 1/);
    delete process.env.ADMIT_INTERVAL_MS;
    process.env.ADMIT_BATCH_SIZE = '-3';
    assert.throws(() => loadConfig(), /ADMIT_BATCH_SIZE must be at least 1/);
  });

  it('fails when the sale times are missing, not a time, or in the wrong order', () => {
    delete process.env.SALE_START;
    assert.throws(() => loadConfig(), /SALE_START is required/);
    process.env.SALE_START = 'tomorrow-ish';
    assert.throws(() => loadConfig(), /SALE_START must be an ISO-8601 time/);
    process.env.SALE_START = '2026-01-01T01:00:00Z'; // equal to the end
    assert.throws(() => loadConfig(), /SALE_END must be after SALE_START/);
  });
});

describe('keys', () => {
  it('puts every key of one sale under the same hash tag', () => {
    for (const key of Object.values(saleKeys('flash-sale-1')))
      assert.match(key, /^sale:\{flash-sale-1\}:/);
  });
  it('keeps different sales apart', () => {
    assert.notEqual(saleKeys('a').stock, saleKeys('b').stock);
  });
  it('scopes rate-limit keys', () => {
    assert.notEqual(rateLimitKey('ip', 'x'), rateLimitKey('user', 'x'));
  });
});

describe('user ID rule', () => {
  it('trims and lowercases', () =>
    assert.equal(normalizeUserId('  Ann@Example.COM '), 'ann@example.com'));
  it('accepts the allowed characters and 64 characters', () => {
    assert.equal(normalizeUserId('a.b_c+d-e@f'), 'a.b_c+d-e@f');
    assert.equal(normalizeUserId('a'.repeat(64)), 'a'.repeat(64));
  });
  it('rejects empty, too long, and other characters', () => {
    for (const bad of ['', '   ', 'a'.repeat(65), 'has space', 'semi;colon', 'ünï', 'a/b', '{x}']) {
      assert.equal(normalizeUserId(bad), null, JSON.stringify(bad));
    }
  });
  it('requireUserId sends 400 for anything that is not a string', () => {
    for (const bad of [undefined, null, 42, {}, ['ann']]) {
      let status = 0;
      const res = { status: (s: number) => ((status = s), { json: () => {} }) } as unknown as Res;
      assert.equal(requireUserId(bad, res), null);
      assert.equal(status, 400);
    }
    assert.equal(requireUserId(' Ann ', {} as Res), 'ann');
  });
});
