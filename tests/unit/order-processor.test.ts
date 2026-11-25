// Order Service Processor with in-memory fakes: no Redis, no Postgres.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { FailureReason } from '@flashsale/shared';
import type { OrderResult } from '@flashsale/shared/node';

import type {
  Entry,
  NewOrder,
  OrderStore,
  RecordOutcome,
  ResultSink,
} from '../../apps/order-service/src/ports';
import { createProcessor } from '../../apps/order-service/src/processor';

const SALE = 'sale-1';
const AT = String(Date.parse('2026-01-01T00:00:00.000Z'));

const entry = (
  id: string,
  userId: string | undefined,
  extra: Partial<Entry> = {},
  saleId = SALE,
): Entry => ({
  id,
  deliveries: 1,
  fields: { ...(userId && { userId }), saleId, reservedAtMs: AT },
  ...extra,
});

class FakeSink implements ResultSink {
  failed: { id: string; reason: FailureReason }[] = [];
  results: OrderResult[] = [];
  acked: string[] = [];
  async copyToFailed(items: { entry: Entry; reason: FailureReason }[]) {
    this.failed.push(...items.map((i) => ({ id: i.entry.id, reason: i.reason })));
  }
  async publishResults(results: OrderResult[]) {
    this.results.push(...results);
  }
  async ack(ids: string[]) {
    this.acked.push(...ids);
  }
}

// Postgres with `stock` units left: a batch is written all together or not at all.
class FakeStore implements OrderStore {
  calls: { saleId: string; messageIds: string[] }[] = [];
  written: string[] = [];
  reservedAt: string[] = [];
  constructor(
    public stock: number,
    private failWith?: Error,
  ) {}
  async recordOrders(saleId: string, orders: NewOrder[]): Promise<RecordOutcome> {
    if (this.failWith) throw this.failWith;
    this.calls.push({ saleId, messageIds: orders.map((o) => o.messageId) });
    if (orders.length > this.stock) return 'out_of_stock';
    this.stock -= orders.length;
    this.written.push(...orders.map((o) => o.messageId));
    this.reservedAt.push(...orders.map((o) => o.reservedAt));
    return 'recorded';
  }
}

describe('Processor', () => {
  let sink: FakeSink;
  let errors: { obj: object; msg?: string }[];
  const log = () => ({
    info() {},
    warn() {},
    error: (obj: object, msg?: string) => void errors.push({ obj, msg }),
  });
  const make = (store: OrderStore) =>
    createProcessor(sink, store, { saleId: SALE, maxDeliveries: 5 }, log());
  const statusOf = (userId: string) => sink.results.find((r) => r.userId === userId);

  beforeEach(() => {
    sink = new FakeSink();
    errors = [];
  });

  it('records a batch in one write, publishes "recorded" for each and acknowledges them', async () => {
    const store = new FakeStore(10);
    await make(store).process([entry('1-0', 'ann'), entry('1-1', 'bob')]);

    assert.deepEqual(store.calls, [{ saleId: SALE, messageIds: ['1-0', '1-1'] }]);
    assert.deepEqual(
      sink.results.map((r) => [r.userId, r.status, r.orderMessageId]),
      [
        ['ann', 'recorded', '1-0'],
        ['bob', 'recorded', '1-1'],
      ],
    );
    assert.deepEqual(sink.acked, ['1-0', '1-1']);
    assert.deepEqual(sink.failed, []);
    assert.equal(errors.length, 0);
  });

  it('stores the purchase time Redis took, converted from epoch milliseconds to ISO-8601', async () => {
    const store = new FakeStore(10);
    await make(store).process([entry('1-0', 'ann')]);
    assert.deepEqual(store.reservedAt, ['2026-01-01T00:00:00.000Z']);
  });

  it('writes one batch per sale', async () => {
    const store = new FakeStore(10);
    await make(store).process([
      entry('1-0', 'ann', {}, 'a'),
      entry('1-1', 'bob', {}, 'b'),
      entry('1-2', 'cy', {}, 'a'),
    ]);
    assert.deepEqual(store.calls, [
      { saleId: 'a', messageIds: ['1-0', '1-2'] },
      { saleId: 'b', messageIds: ['1-1'] },
    ]);
  });

  describe('invalid messages', () => {
    it('moves a message with a missing field or a bad time to the failed stream, without touching Postgres', async () => {
      const store = new FakeStore(10);
      const badTime = entry('1-1', 'bob');
      badTime.fields.reservedAtMs = 'not-a-date';
      await make(store).process([
        entry('1-0', 'ann', { fields: { userId: 'ann', saleId: SALE } }),
        badTime,
      ]);

      assert.equal(store.calls.length, 0);
      assert.deepEqual(sink.failed, [
        { id: '1-0', reason: 'invalid_message' },
        { id: '1-1', reason: 'invalid_message' },
      ]);
      assert.deepEqual(
        sink.results.map((r) => [r.userId, r.status, r.reason]),
        [
          ['ann', 'failed', 'invalid_message'],
          ['bob', 'failed', 'invalid_message'],
        ],
      );
      assert.deepEqual(sink.acked, ['1-0', '1-1']);
    });

    it('acknowledges a message with no user ID but has nobody to tell', async () => {
      await make(new FakeStore(10)).process([entry('1-0', undefined)]);
      assert.deepEqual(sink.failed, [{ id: '1-0', reason: 'invalid_message' }]);
      assert.deepEqual(sink.results, []);
      assert.deepEqual(sink.acked, ['1-0']);
    });

    it('uses the configured sale ID for the result when the message has none', async () => {
      const bad = entry('1-0', 'ann');
      delete bad.fields.saleId;
      delete bad.fields.reservedAtMs;
      await make(new FakeStore(10)).process([bad]);
      assert.equal(statusOf('ann')?.saleId, SALE);
    });
  });

  it('gives up on a message delivered more than maxDeliveries times', async () => {
    const store = new FakeStore(10);
    await make(store).process([
      entry('1-0', 'ann', { deliveries: 6 }),
      entry('1-1', 'bob', { deliveries: 5 }),
    ]);

    assert.deepEqual(sink.failed, [{ id: '1-0', reason: 'processing_error' }]);
    assert.equal(statusOf('ann')?.reason, 'processing_error');
    assert.deepEqual(store.calls, [{ saleId: SALE, messageIds: ['1-1'] }]); // exactly 5 deliveries is still allowed
    assert.equal(statusOf('bob')?.status, 'recorded');
  });

  describe('Postgres out of stock but Redis accepted the orders', () => {
    it('keeps the earliest purchases, fails the rest as sold_out and raises an integrity alert', async () => {
      const store = new FakeStore(2);
      // arrival order is not purchase order
      await make(store).process([
        entry('5-0', 'late'),
        entry('1-1', 'second'),
        entry('1-0', 'first'),
      ]);

      assert.deepEqual(store.written, ['1-0', '1-1']);
      assert.equal(statusOf('first')?.status, 'recorded');
      assert.equal(statusOf('second')?.status, 'recorded');
      assert.deepEqual(
        [statusOf('late')?.status, statusOf('late')?.reason],
        ['failed', 'sold_out'],
      );
      assert.deepEqual(sink.failed, [{ id: '5-0', reason: 'sold_out' }]);
      assert.deepEqual([...sink.acked].sort(), ['1-0', '1-1', '5-0']);
      assert.equal(errors.length, 1);
      assert.equal((errors[0].obj as { alert: string }).alert, 'INTEGRITY_ALERT');
    });

    it('compares message IDs as numbers, so 9-0 is earlier than 10-0', async () => {
      const store = new FakeStore(1);
      await make(store).process([entry('10-0', 'ten'), entry('9-0', 'nine')]);
      assert.equal(statusOf('nine')?.status, 'recorded');
      assert.equal(statusOf('ten')?.reason, 'sold_out');
    });

    it('orders by the sequence part when the millisecond part is equal', async () => {
      const store = new FakeStore(1);
      await make(store).process([entry('7-10', 'b'), entry('7-2', 'a')]);
      assert.equal(statusOf('a')?.status, 'recorded');
      assert.equal(statusOf('b')?.reason, 'sold_out');
    });
  });

  it('rejects and acknowledges nothing when Postgres fails, so the batch comes back through reclaim', async () => {
    const store = new FakeStore(10, new Error('connection refused'));
    await assert.rejects(make(store).process([entry('1-0', 'ann')]), /connection refused/);
    assert.deepEqual(sink.acked, []);
    assert.deepEqual(sink.results, []);
  });
});
