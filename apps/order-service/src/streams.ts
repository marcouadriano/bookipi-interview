import type { Redis } from 'ioredis';

import type { FailureReason } from '@flashsale/shared';
import {
  ensureConsumerGroup,
  execPipeline,
  fieldsToObject,
  FAILED_ORDERS_STREAM,
  ORDERS_STREAM,
  ORDER_RESULTS_STREAM,
  type OrderResult,
  type RawEntry,
} from '@flashsale/shared/node';

import type { Entry, OrderSource, ResultSink } from './ports';

export const CONSUMER_GROUP = 'order-service';
const RESULTS_MAXLEN = 100_000;

export interface StreamOptions {
  consumerName: string;
  batchSize: number;
  blockMs: number;
  reclaimIdleMs: number;
}

const toFlat = (fields: Record<string, string>) => Object.entries(fields).flat();

const toEntries = (raw: RawEntry[], deliveries: Map<string, number>): Entry[] =>
  raw.flatMap(([id, flat]) =>
    flat
      ? [
          {
            id,
            fields: fieldsToObject(flat),
            deliveries: deliveries.get(id) ?? 1,
          },
        ]
      : [],
  );

export class OrderStreams implements OrderSource, ResultSink {
  // redis: normal commands (XADD, XACK, XAUTOCLAIM, XPENDING)
  // blocking: its own connection, because a blocking read holds it until it returns
  constructor(
    private redis: Redis,
    private blocking: Redis,
    private options: StreamOptions,
  ) {}

  ensureGroup(): Promise<void> {
    return ensureConsumerGroup(this.redis, ORDERS_STREAM, CONSUMER_GROUP);
  }

  // New messages for this consumer. Blocks up to BLOCK_MS.
  async readNew(): Promise<Entry[]> {
    const reply = (await this.blocking.call(
      'XREADGROUP',
      'GROUP',
      CONSUMER_GROUP,
      this.options.consumerName,
      'COUNT',
      this.options.batchSize,
      'BLOCK',
      this.options.blockMs,
      'STREAMS',
      ORDERS_STREAM,
      '>',
    )) as [string, RawEntry[]][] | null;
    return reply ? toEntries(reply[0][1], new Map()) : [];
  }

  // Claims one page of messages idle longer than
  // RECLAIM_IDLE_MS. `next` is '0-0' when there are no more.
  async reclaimPage(start: string): Promise<{ next: string; entries: Entry[] }> {
    const [next, raw] = (await this.redis.call(
      'XAUTOCLAIM',
      ORDERS_STREAM,
      CONSUMER_GROUP,
      this.options.consumerName,
      this.options.reclaimIdleMs,
      start,
      'COUNT',
      this.options.batchSize,
    )) as [string, RawEntry[]];
    const live = raw.filter(([, flat]) => flat);
    return {
      next,
      entries: toEntries(raw, await this.deliveryCounts(live.map(([id]) => id))),
    };
  }

  private async deliveryCounts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.xpending(ORDERS_STREAM, CONSUMER_GROUP, id, id, 1);
    const replies = (await pipeline.exec()) ?? [];
    const counts = new Map<string, number>();
    replies.forEach(([err, rows], i) => {
      if (err) throw err;
      const row = (rows as [string, string, number, number][])[0];
      if (row) counts.set(ids[i], row[3]);
    });
    return counts;
  }

  async copyToFailed(items: { entry: Entry; reason: FailureReason }[]): Promise<void> {
    if (items.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const { entry, reason } of items) {
      pipeline.xadd(
        FAILED_ORDERS_STREAM,
        '*',
        ...toFlat({
          ...entry.fields,
          reason,
          deliveries: String(entry.deliveries),
          failedAt: new Date().toISOString(),
        }),
      );
    }
    await execPipeline(pipeline);
  }

  async publishResults(results: OrderResult[]): Promise<void> {
    if (results.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const r of results) {
      const fields: Record<string, string> = {
        saleId: r.saleId,
        userId: r.userId,
        status: r.status,
        orderMessageId: r.orderMessageId,
        at: r.at,
      };
      if (r.reason) fields.reason = r.reason;
      pipeline.xadd(ORDER_RESULTS_STREAM, 'MAXLEN', '~', RESULTS_MAXLEN, '*', ...toFlat(fields));
    }
    await execPipeline(pipeline);
  }

  async ack(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.redis.xack(ORDERS_STREAM, CONSUMER_GROUP, ...ids);
  }

  async counts(): Promise<{ pendingMessages: number; failedOrders: number }> {
    const pending = (await this.redis.xpending(ORDERS_STREAM, CONSUMER_GROUP)) as [number];
    return {
      pendingMessages: Number(pending[0]),
      failedOrders: await this.redis.xlen(FAILED_ORDERS_STREAM),
    };
  }
}
