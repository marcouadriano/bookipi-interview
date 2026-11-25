import type {
  FailureReason,
  QueueStatusResponse,
  SaleStatus,
  SaleStatusResponse,
} from '@flashsale/shared';

export type Purchase =
  | { kind: 'none' }
  | { kind: 'processing' | 'still_processing' | 'success' | 'rejected' }
  | { kind: 'failed'; reason?: FailureReason };

// A purchase result takes over the page, so every purchase kind except `none` is also a page state.
export type PageState =
  | 'loading'
  | 'upcoming'
  | 'ready'
  | 'waiting'
  | 'admitted'
  | 'expired'
  | 'ended'
  | 'sold_out'
  | Exclude<Purchase['kind'], 'none'>;

// The page may flip upcoming to active when its countdown
// hits zero; the server still decides the rest.
export function effectiveSaleStatus(
  sale: SaleStatusResponse | null,
  serverNow: number,
): SaleStatus | null {
  if (!sale) return null;
  if (sale.status === 'upcoming' && serverNow >= Date.parse(sale.startsAt)) return 'active';
  return sale.status;
}

// State table. Priority: purchase result, then sale over, then upcoming, then queue.
export function derivePageState(
  saleStatus: SaleStatus | null,
  purchase: Purchase,
  queue: QueueStatusResponse | null,
  serverNow: number,
): PageState {
  if (!saleStatus) return 'loading';
  if (purchase.kind !== 'none') return purchase.kind;
  if (saleStatus === 'ended' || saleStatus === 'sold_out') return saleStatus;
  if (saleStatus === 'upcoming') return 'upcoming';
  if (queue?.state === 'waiting') return 'waiting';
  if (queue?.state === 'admitted') {
    const over = queue.admittedUntil && serverNow >= Date.parse(queue.admittedUntil);
    return over ? 'expired' : 'admitted';
  }
  if (queue?.state === 'expired') return 'expired';
  return 'ready';
}

const ACTIVE_ID_STATES: readonly PageState[] = ['waiting', 'admitted', 'processing'];

// Checking an order uses the ID in play, not whatever is typed in the box.
export const isLockedToActiveId = (state: PageState) => ACTIVE_ID_STATES.includes(state);

export const isIdLocked = (state: PageState) =>
  isLockedToActiveId(state) || state === 'still_processing';
