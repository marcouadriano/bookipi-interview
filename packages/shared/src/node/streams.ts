import type { FailureReason } from '../api';

// Redis stream names and the messages that travel on them.

export const ORDERS_STREAM = 'flashsale:orders';
export const ORDER_RESULTS_STREAM = 'flashsale:order-results';
export const FAILED_ORDERS_STREAM = 'flashsale:orders:failed';

// Written by the Sale Service to `flashsale:orders`, in the same atomic step that takes the stock
export interface OrderMessage {
  saleId: string;
  userId: string;
  reservedAtMs: number; // epoch milliseconds, from Redis's clock
}

// Written by the Order Service to `flashsale:order-results`
export interface OrderResult {
  saleId: string;
  userId: string;
  status: 'recorded' | 'failed';
  reason?: FailureReason; // only when failed
  orderMessageId: string;
  at: string; // ISO-8601
}
