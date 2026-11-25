import type { Redis } from 'ioredis';

import type { FailureReason } from '@flashsale/shared';
import {
  ensureConsumerGroup,
  fieldsToObject,
  ORDER_RESULTS_STREAM,
  type OrderResult,
  type RawEntry,
} from '@flashsale/shared/node';

import type { ResultEntry, ResultSource } from '../ports';

export const RESULTS_GROUP = 'sale-service';
// One consumer name for every Purchase instance, so a restarted instance can pick up
// whatever a crashed one left unacknowledged (repeats are harmless).
const CONSUMER = 'purchase-app';
const BATCH = 100;
const BLOCK_MS = 2000;

function toResult(flat: string[] | null): OrderResult | null {
  if (!flat) return null;
  const f = fieldsToObject(flat);
  if (!f.saleId || !f.userId || (f.status !== 'recorded' && f.status !== 'failed')) return null;
  return {
    saleId: f.saleId,
    userId: f.userId,
    status: f.status,
    ...(f.reason && { reason: f.reason as FailureReason }),
    orderMessageId: f.orderMessageId,
    at: f.at,
  };
}

const toEntries = (raw: RawEntry[]): ResultEntry[] =>
  raw.map(([id, flat]) => ({ id, result: toResult(flat) }));

// Reads and acknowledges the results stream. Applying results is `RedisResultApplier`'s job.
//
// redis: normal commands
// blocking: its own connection, because a blocking read holds it until it returns
export class RedisResultStream implements ResultSource {
  constructor(
    private redis: Redis,
    private blocking: Redis,
  ) {}

  ensureGroup(): Promise<void> {
    return ensureConsumerGroup(this.redis, ORDER_RESULTS_STREAM, RESULTS_GROUP);
  }

  async readPending(): Promise<ResultEntry[]> {
    const reply = (await this.redis.call(
      'XREADGROUP',
      'GROUP',
      RESULTS_GROUP,
      CONSUMER,
      'COUNT',
      BATCH,
      'STREAMS',
      ORDER_RESULTS_STREAM,
      '0',
    )) as [string, RawEntry[]][] | null;
    return reply ? toEntries(reply[0][1]) : [];
  }

  async readNew(): Promise<ResultEntry[]> {
    const reply = (await this.blocking.call(
      'XREADGROUP',
      'GROUP',
      RESULTS_GROUP,
      CONSUMER,
      'COUNT',
      BATCH,
      'BLOCK',
      BLOCK_MS,
      'STREAMS',
      ORDER_RESULTS_STREAM,
      '>',
    )) as [string, RawEntry[]][] | null;
    return reply ? toEntries(reply[0][1]) : [];
  }

  async ack(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.redis.xack(ORDER_RESULTS_STREAM, RESULTS_GROUP, ...ids);
  }

  // Results not yet applied: delivered but unacknowledged, plus not yet delivered.
  async backlog(): Promise<number> {
    const groups = (await this.redis.xinfo('GROUPS', ORDER_RESULTS_STREAM)) as unknown[][];
    for (const g of groups) {
      const info = fieldsToObject(g as string[]); // pending and lag are numbers at runtime
      if (info.name === RESULTS_GROUP) return Number(info.pending ?? 0) + Number(info.lag ?? 0);
    }
    return 0;
  }
}
