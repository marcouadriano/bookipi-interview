import type { FailureReason } from '@flashsale/shared';
import type { BaseLogger, OrderMessage, OrderResult } from '@flashsale/shared/node';

import type { Entry, NewOrder, OrderStore, ResultSink } from './ports';

export interface ProcessorOptions {
  saleId: string; // used for the result of an invalid message that has no saleId
  maxDeliveries: number;
}

interface Order {
  entry: Entry;
  message: OrderMessage;
}

function parseOrder(fields: Record<string, string>): OrderMessage | null {
  const { saleId, userId, reservedAtMs } = fields;
  if (!saleId || !userId || !reservedAtMs || !Number.isFinite(Number(reservedAtMs))) return null;
  return { saleId, userId, reservedAtMs: Number(reservedAtMs) };
}

// Stream ids are `ms-seq`; the lower one is the earlier purchase.
function byMessageId(a: Order, b: Order): number {
  const [am, as] = a.entry.id.split('-').map(BigInt);
  const [bm, bs] = b.entry.id.split('-').map(BigInt);
  return am === bm ? Number(as - bs) : Number(am - bm);
}

function parseEntries(entries: Entry[]): { orders: Order[]; invalid: Entry[] } {
  const orders: Order[] = [];
  const invalid: Entry[] = [];
  for (const entry of entries) {
    const message = parseOrder(entry.fields);
    if (message) orders.push({ entry, message });
    else invalid.push(entry);
  }
  return { orders, invalid };
}

function groupBySale(orders: Order[]): Map<string, Order[]> {
  const bySale = new Map<string, Order[]>();
  for (const order of orders) {
    const group = bySale.get(order.message.saleId);
    if (group) group.push(order);
    else bySale.set(order.message.saleId, [order]);
  }
  return bySale;
}

export interface Processor {
  process(entries: Entry[]): Promise<void>;
}

export function createProcessor(
  sink: ResultSink,
  store: OrderStore,
  options: ProcessorOptions,
  log: BaseLogger,
): Processor {
  // Move messages to the failed stream, publish `failed` where the user is readable, acknowledge.
  async function fail(entries: Entry[], reason: FailureReason): Promise<void> {
    if (entries.length === 0) return;

    log.warn(
      {
        ids: entries.map((e) => e.id),
        reason,
      },
      'moving messages to failed orders',
    );

    await sink.copyToFailed(entries.map((entry) => ({ entry, reason })));
    await sink.publishResults(
      entries
        .filter((e) => e.fields.userId)
        .map((e) =>
          result(e.id, e.fields.saleId || options.saleId, e.fields.userId, 'failed', reason),
        ),
    );
    await sink.ack(entries.map((e) => e.id));
  }

  // Copy sold-out orders to the failed stream, publish one result each, then acknowledge.
  async function finish(recorded: Order[], soldOut: Order[]): Promise<void> {
    await sink.copyToFailed(soldOut.map((o) => ({ entry: o.entry, reason: 'sold_out' as const })));
    await sink.publishResults([
      ...recorded.map((o) => result(o.entry.id, o.message.saleId, o.message.userId, 'recorded')),
      ...soldOut.map((o) =>
        result(o.entry.id, o.message.saleId, o.message.userId, 'failed', 'sold_out'),
      ),
    ]);
    await sink.ack([...recorded, ...soldOut].map((o) => o.entry.id));
  }

  async function record(saleId: string, orders: Order[]): Promise<void> {
    const toNew = (o: Order): NewOrder => ({
      messageId: o.entry.id,
      userId: o.message.userId,
      reservedAt: new Date(o.message.reservedAtMs).toISOString(),
    });

    if ((await store.recordOrders(saleId, orders.map(toNew))) === 'recorded') {
      return finish(orders, []);
    }

    // Postgres is out of stock but Redis thought there was some. Earliest purchases win.
    log.error(
      {
        alert: 'INTEGRITY_ALERT',
        batchSize: orders.length,
        saleId,
      },
      'INTEGRITY_ALERT: Postgres is out of stock but Redis accepted these orders',
    );

    const recorded: Order[] = [];
    const soldOut: Order[] = [];
    for (const order of [...orders].sort(byMessageId)) {
      const outcome = await store.recordOrders(saleId, [toNew(order)]);
      (outcome === 'recorded' ? recorded : soldOut).push(order);
    }
    await finish(recorded, soldOut);
  }

  return {
    // An error thrown here leaves the entries not yet handled unacknowledged;
    // they come back through reclaim after the worker backs off.
    async process(entries: Entry[]): Promise<void> {
      const tooMany = entries.filter((e) => e.deliveries > options.maxDeliveries);
      await fail(tooMany, 'processing_error');

      const { orders, invalid } = parseEntries(
        entries.filter((e) => e.deliveries <= options.maxDeliveries),
      );
      await fail(invalid, 'invalid_message');

      for (const [saleId, saleOrders] of groupBySale(orders)) await record(saleId, saleOrders);
    },
  };
}

function result(
  orderMessageId: string,
  saleId: string,
  userId: string,
  status: OrderResult['status'],
  reason?: FailureReason,
): OrderResult {
  return {
    saleId,
    userId,
    status,
    ...(reason && { reason }),
    orderMessageId,
    at: new Date().toISOString(),
  };
}
