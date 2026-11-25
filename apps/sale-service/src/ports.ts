// The result types the Redis classes return, and the interfaces the code depends on instead of
// Redis and Postgres. The tests replace `BuyerSource` and `RateLimiter` with fakes.
import type { OrderResult } from '@flashsale/shared/node';
import type { QueueStatusResponse, SaleStatus } from '@flashsale/shared';

export type JoinResult =
  | { kind: 'unavailable' } // ready marker missing
  | { kind: 'already_purchased' }
  | { kind: 'sale_not_active' }
  | { kind: 'queued'; status: QueueStatusResponse };

export type PurchaseResult =
  | {
      kind: 'accepted' | 'unavailable' | 'already_purchased' | 'not_admitted' | 'sold_out';
    }
  | { kind: 'sale_not_active'; saleStatus: SaleStatus };

export interface ResultEntry {
  id: string;
  result: OrderResult | null; // null: malformed, skip it
}

export interface ResultSource {
  ensureGroup(): Promise<void>;
  // Messages this group already delivered but never acknowledged.
  readPending(): Promise<ResultEntry[]>;
  // New messages. Blocks briefly.
  readNew(): Promise<ResultEntry[]>;
  ack(ids: string[]): Promise<void>;
}

// Postgres, through the read-only view. Used only by the rebuild.
export interface BuyerSource {
  buyers(saleId: string): Promise<string[]>;
}

export interface RateLimiter {
  hit(
    key: string,
    max: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAfterSec: number }>;
}
