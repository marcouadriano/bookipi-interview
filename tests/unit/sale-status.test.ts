import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { saleStatusAt } from '../../apps/sale-service/src/saleStatus';

const window = { saleStartMs: 1000, saleEndMs: 2000 };

describe('saleStatusAt', () => {
  it('is upcoming before the start', () => assert.equal(saleStatusAt(999, 10, window), 'upcoming'));

  it('is active from the start to the end, inclusive', () => {
    assert.equal(saleStatusAt(1000, 10, window), 'active');
    assert.equal(saleStatusAt(2000, 10, window), 'active');
  });

  it('is ended after the end', () => assert.equal(saleStatusAt(2001, 10, window), 'ended'));

  it('is sold_out inside the window when the stock is gone', () => {
    assert.equal(saleStatusAt(1500, 0, window), 'sold_out');
    assert.equal(saleStatusAt(1500, -1, window), 'sold_out');
  });

  it('treats a missing stock key as in stock', () =>
    assert.equal(saleStatusAt(1500, null, window), 'active'));

  it('reports the time before sold_out: upcoming and ended win', () => {
    assert.equal(saleStatusAt(500, 0, window), 'upcoming');
    assert.equal(saleStatusAt(3000, 0, window), 'ended');
  });
});
