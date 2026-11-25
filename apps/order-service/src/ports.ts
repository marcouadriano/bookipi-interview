// The narrow interfaces each part depends on. Redis and Postgres implement them in
// streams.ts and orders.ts; the worker and processor never import those modules directly.
import type { FailureReason } from '@flashsale/shared';
import type { OrderResult } from '@flashsale/shared/node';

export interface Entry {
  id: string;
  fields: Record<string, string>;
  deliveries: number;
}

export interface NewOrder {
  messageId: string;
  userId: string;
  reservedAt: string;
}

// 'recorded': every order now has a row (new or already there). 'out_of_stock': nothing written.
export type RecordOutcome = 'recorded' | 'out_of_stock';

export interface OrderSource {
  ensureGroup(): Promise<void>;
  readNew(): Promise<Entry[]>;
  reclaimPage(start: string): Promise<{ next: string; entries: Entry[] }>;
}

export interface ResultSink {
  copyToFailed(items: { entry: Entry; reason: FailureReason }[]): Promise<void>;
  publishResults(results: OrderResult[]): Promise<void>;
  ack(ids: string[]): Promise<void>;
}

export interface OrderStore {
  recordOrders(saleId: string, orders: NewOrder[]): Promise<RecordOutcome>;
}
