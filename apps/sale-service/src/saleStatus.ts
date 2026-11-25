import type { SaleStatus } from '@flashsale/shared';

// `stock` is null when Redis has no stock key yet.
export function saleStatusAt(
  nowMs: number,
  stock: number | null,
  window: { saleStartMs: number; saleEndMs: number },
): SaleStatus {
  if (nowMs < window.saleStartMs) return 'upcoming';
  if (nowMs > window.saleEndMs) return 'ended';
  if (stock !== null && stock <= 0) return 'sold_out';
  return 'active';
}
