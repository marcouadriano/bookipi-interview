import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QueueStatusResponse, SaleStatusResponse } from '@flashsale/shared';

import { formatCountdown } from '../../apps/web/src/format';
import {
  codeMessage,
  purchaseStateMessage,
  saleStatusMessage,
  text,
} from '../../apps/web/src/messages';
import { derivePageState, effectiveSaleStatus, type Purchase } from '../../apps/web/src/pageState';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const none: Purchase = { kind: 'none' };
const queue = (
  state: QueueStatusResponse['state'],
  admittedUntil?: string,
): QueueStatusResponse => ({
  userId: 'ann',
  state,
  admittedUntil,
});

describe('derivePageState', () => {
  it('is loading until the sale status is known', () =>
    assert.equal(derivePageState(null, none, null, NOW), 'loading'));

  it('shows the purchase result over everything else', () => {
    for (const kind of ['processing', 'still_processing', 'success', 'rejected'] as const) {
      assert.equal(derivePageState('sold_out', { kind }, queue('admitted'), NOW), kind);
    }
    assert.equal(
      derivePageState('ended', { kind: 'failed', reason: 'sold_out' }, null, NOW),
      'failed',
    );
  });

  it('shows ended, sold_out and upcoming from the sale status', () => {
    assert.equal(derivePageState('ended', none, queue('waiting'), NOW), 'ended');
    assert.equal(derivePageState('sold_out', none, queue('admitted'), NOW), 'sold_out');
    assert.equal(derivePageState('upcoming', none, null, NOW), 'upcoming');
  });

  it('follows the queue while the sale is active', () => {
    assert.equal(derivePageState('active', none, null, NOW), 'ready');
    assert.equal(derivePageState('active', none, queue('waiting'), NOW), 'waiting');
    assert.equal(derivePageState('active', none, queue('expired'), NOW), 'expired');
  });

  it('is admitted until admittedUntil passes, then expired', () => {
    const until = new Date(NOW + 1000).toISOString();
    assert.equal(derivePageState('active', none, queue('admitted', until), NOW), 'admitted');
    assert.equal(derivePageState('active', none, queue('admitted', until), NOW + 999), 'admitted');
    assert.equal(derivePageState('active', none, queue('admitted', until), NOW + 1000), 'expired');
  });
});

describe('effectiveSaleStatus', () => {
  const sale = (status: SaleStatusResponse['status']): SaleStatusResponse => ({
    status,
    startsAt: new Date(NOW).toISOString(),
    endsAt: new Date(NOW + 3600_000).toISOString(),
    serverTime: new Date(NOW).toISOString(),
  });

  it('is null without a sale', () => assert.equal(effectiveSaleStatus(null, NOW), null));
  it('flips upcoming to active once the start time is reached', () => {
    assert.equal(effectiveSaleStatus(sale('upcoming'), NOW - 1), 'upcoming');
    assert.equal(effectiveSaleStatus(sale('upcoming'), NOW), 'active');
  });
  it('never second-guesses the server for the other statuses', () => {
    for (const s of ['active', 'ended', 'sold_out'] as const)
      assert.equal(effectiveSaleStatus(sale(s), NOW + 1e9), s);
  });
});

describe('formatCountdown', () => {
  it('formats minutes and seconds', () => {
    assert.equal(formatCountdown(0), '0:00');
    assert.equal(formatCountdown(59_000), '0:59');
    assert.equal(formatCountdown(61_000), '1:01');
    assert.equal(formatCountdown(118_000), '1:58');
  });
  it('rounds partial seconds up, so it never shows 0:00 before the time is up', () => {
    assert.equal(formatCountdown(1), '0:01');
    assert.equal(formatCountdown(1001), '0:02');
  });
  it('adds hours', () => {
    assert.equal(formatCountdown(3_600_000), '1:00:00');
    assert.equal(formatCountdown(3_661_000), '1:01:01');
  });
  it('clamps negative time to zero', () => assert.equal(formatCountdown(-5000), '0:00'));
});

describe('messages', () => {
  it('maps purchase states to feedback', () => {
    assert.deepEqual(purchaseStateMessage('success'), {
      text: text.success,
      tone: 'success',
    });
    assert.deepEqual(purchaseStateMessage('processing'), {
      text: text.processing,
      tone: 'neutral',
    });
    assert.deepEqual(purchaseStateMessage('failed', 'sold_out'), {
      text: text.failedSoldOut,
      tone: 'neutral',
    });
    assert.deepEqual(purchaseStateMessage('failed', 'processing_error'), {
      text: text.failedOther,
      tone: 'error',
    });
    assert.equal(purchaseStateMessage('none').text, '');
  });
  it('maps sale statuses, treating an unknown one as ended', () => {
    assert.equal(saleStatusMessage('upcoming').text, text.notStarted);
    assert.equal(saleStatusMessage('sold_out').text, text.soldOut);
    assert.equal(saleStatusMessage('ended').text, text.ended);
    assert.equal(saleStatusMessage(undefined).text, text.ended);
  });
  it('maps API error codes, with a generic fallback', () => {
    assert.equal(codeMessage('invalid_user_id').text, text.invalidUserId);
    assert.equal(codeMessage('rate_limited').tone, 'error');
    assert.equal(codeMessage('temporarily_unavailable').text, text.unavailable);
    assert.deepEqual(codeMessage(undefined), {
      text: text.internal,
      tone: 'error',
    });
    assert.deepEqual(codeMessage('internal'), {
      text: text.internal,
      tone: 'error',
    });
  });
});
