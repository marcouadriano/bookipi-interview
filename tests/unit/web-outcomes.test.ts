// The page's decisions that have no React in them: what a join or buy reply means, countdown labels, which message shows.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PurchaseResponse, QueueStatusResponse, SaleStatusResponse } from '@flashsale/shared';

import type { ApiResult } from '../../apps/web/src/api';
import { saleCountdown } from '../../apps/web/src/format';
import { displayMessage, msg, text } from '../../apps/web/src/messages';
import { buyOutcome, joinOutcome } from '../../apps/web/src/outcomes';
import { isIdLocked, isLockedToActiveId, type PageState } from '../../apps/web/src/pageState';

const queued: QueueStatusResponse = { userId: 'ann', state: 'waiting' };
const bought = (
  outcome: PurchaseResponse['outcome'],
  saleStatus?: PurchaseResponse['saleStatus'],
): ApiResult<PurchaseResponse> => ({
  status: 200,
  data: { outcome, userId: 'ann', saleStatus },
});

describe('joinOutcome', () => {
  it('queues on a 200 with a body', () => {
    assert.deepEqual(joinOutcome({ status: 200, data: queued }), {
      kind: 'queued',
      queue: queued,
    });
  });

  it('recognises the two errors the page handles itself', () => {
    assert.deepEqual(joinOutcome({ status: 409, code: 'already_purchased' }), {
      kind: 'already_purchased',
    });
    assert.deepEqual(joinOutcome({ status: 403, code: 'sale_not_active' }), {
      kind: 'sale_not_active',
    });
  });

  it('turns any other error into its message', () => {
    assert.deepEqual(joinOutcome({ status: 429, code: 'rate_limited' }), {
      kind: 'failed',
      message: msg(text.rateLimited, 'error'),
    });
    assert.deepEqual(joinOutcome({ status: 503, code: 'temporarily_unavailable' }), {
      kind: 'failed',
      message: msg(text.unavailable),
    });
  });

  it('falls back to the generic message for a 200 without a body or an unknown reply', () => {
    assert.deepEqual(joinOutcome({ status: 200 }), {
      kind: 'failed',
      message: msg(text.internal, 'error'),
    });
    assert.deepEqual(joinOutcome({ status: 500 }), {
      kind: 'failed',
      message: msg(text.internal, 'error'),
    });
  });
});

describe('buyOutcome', () => {
  it('maps each purchase outcome', () => {
    assert.deepEqual(buyOutcome(bought('accepted')), { kind: 'accepted' });
    assert.deepEqual(buyOutcome(bought('already_purchased')), {
      kind: 'already_purchased',
    });
    assert.deepEqual(buyOutcome(bought('not_admitted')), {
      kind: 'not_admitted',
    });
    assert.deepEqual(buyOutcome(bought('sold_out')), {
      kind: 'rejected',
      message: msg(text.soldOut),
    });
  });

  it('explains a sale that is not active by its status', () => {
    assert.deepEqual(buyOutcome(bought('sale_not_active', 'upcoming')), {
      kind: 'rejected',
      message: msg(text.notStarted),
    });
    assert.deepEqual(buyOutcome(bought('sale_not_active', 'ended')), {
      kind: 'rejected',
      message: msg(text.ended),
    });
    assert.deepEqual(buyOutcome(bought('sale_not_active')), {
      kind: 'rejected',
      message: msg(text.ended),
    });
  });

  it('turns an error reply into its message', () => {
    assert.deepEqual(buyOutcome({ status: 429, code: 'rate_limited' }), {
      kind: 'failed',
      message: msg(text.rateLimited, 'error'),
    });
    assert.deepEqual(buyOutcome({ status: 400, code: 'invalid_user_id' }), {
      kind: 'failed',
      message: msg(text.invalidUserId, 'error'),
    });
    assert.deepEqual(buyOutcome({ status: 500 }), {
      kind: 'failed',
      message: msg(text.internal, 'error'),
    });
  });
});

describe('saleCountdown', () => {
  const NOW = Date.parse('2026-01-01T00:00:00Z');
  const sale: SaleStatusResponse = {
    status: 'upcoming',
    startsAt: '2026-01-01T00:01:30Z',
    endsAt: '2026-01-01T01:00:00Z',
    serverTime: '2026-01-01T00:00:00Z',
  };

  it('counts down to the start while upcoming and to the end while active', () => {
    assert.equal(saleCountdown(sale, 'upcoming', NOW), 'Starts in 1:30');
    assert.equal(saleCountdown(sale, 'active', NOW), 'Ends in 1:00:00');
  });

  it('is empty when there is nothing to count', () => {
    assert.equal(saleCountdown(null, null, NOW), '');
    assert.equal(saleCountdown(sale, 'ended', NOW), '');
    assert.equal(saleCountdown(sale, 'sold_out', NOW), '');
  });
});

describe('displayMessage', () => {
  it('prefers an explicit message', () => {
    assert.deepEqual(displayMessage(msg('x'), 'ended'), msg('x'));
  });

  it('shows the sale-over message on load when there is none', () => {
    assert.deepEqual(displayMessage(null, 'sold_out'), msg(text.soldOut));
    assert.deepEqual(displayMessage(null, 'ended'), msg(text.ended));
  });

  it('is empty otherwise', () => {
    assert.equal(displayMessage(null, 'ready'), null);
    assert.equal(displayMessage(null, 'success'), null);
  });
});

describe('id locking', () => {
  const states: PageState[] = [
    'loading',
    'upcoming',
    'ready',
    'waiting',
    'admitted',
    'expired',
    'processing',
    'still_processing',
    'success',
    'failed',
    'rejected',
    'ended',
    'sold_out',
  ];

  it('checks the active id while waiting, admitted or processing', () => {
    assert.deepEqual(states.filter(isLockedToActiveId), ['waiting', 'admitted', 'processing']);
  });

  it('locks the input for those states and while still processing', () => {
    assert.deepEqual(states.filter(isIdLocked), [
      'waiting',
      'admitted',
      'processing',
      'still_processing',
    ]);
  });
});
