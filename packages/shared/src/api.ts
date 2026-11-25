export type SaleStatus = 'upcoming' | 'active' | 'ended' | 'sold_out';

export interface SaleStatusResponse {
  status: SaleStatus;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}

export type QueueState = 'waiting' | 'admitted' | 'expired';

export interface QueueStatusResponse {
  userId: string;
  state: QueueState;
  admittedUntil?: string;
}

export type PurchaseOutcome =
  'accepted' | 'already_purchased' | 'sold_out' | 'sale_not_active' | 'not_admitted';

export interface PurchaseResponse {
  outcome: PurchaseOutcome;
  userId: string;
  saleStatus?: SaleStatus;
}

export type PurchaseState = 'none' | 'processing' | 'success' | 'failed';
export type FailureReason = 'sold_out' | 'processing_error' | 'invalid_message';

export interface UserPurchaseResponse {
  userId: string;
  state: PurchaseState;
  reason?: FailureReason;
}

export type ApiErrorCode =
  | 'invalid_user_id'
  | 'not_found'
  | 'rate_limited'
  | 'sale_not_active'
  | 'already_purchased'
  | 'temporarily_unavailable'
  | 'internal';

export interface ApiErrorResponse {
  error: { code: ApiErrorCode; message: string };
}
