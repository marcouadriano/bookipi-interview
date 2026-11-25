import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../../apps/order-service/src/config';

describe('order service loadConfig', () => {
  const names = ['BATCH_SIZE', 'BLOCK_MS'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names) delete process.env[n];
  });
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('applies defaults', () => {
    const c = loadConfig();
    assert.deepEqual([c.batchSize, c.blockMs], [100, 2000]);
  });

  it('reads overrides from the environment', () => {
    process.env.BATCH_SIZE = '7';
    process.env.BLOCK_MS = '300';
    const c = loadConfig();
    assert.deepEqual([c.batchSize, c.blockMs], [7, 300]);
  });

  it('rejects a batch size or block time below 1', () => {
    process.env.BATCH_SIZE = '0';
    assert.throws(() => loadConfig(), /BATCH_SIZE must be at least 1/);
    delete process.env.BATCH_SIZE;
    process.env.BLOCK_MS = '0'; // 0 would make Redis block forever
    assert.throws(() => loadConfig(), /BLOCK_MS must be at least 1/);
  });
});
