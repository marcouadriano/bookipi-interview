import type { SaleStatus, SaleStatusResponse } from '@flashsale/shared';

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

// "Starts in …" before the sale, "Ends in …" during it, nothing otherwise.
export function saleCountdown(
  sale: SaleStatusResponse | null,
  status: SaleStatus | null,
  serverNow: number,
): string {
  if (!sale) return '';
  if (status === 'upcoming')
    return `Starts in ${formatCountdown(Date.parse(sale.startsAt) - serverNow)}`;
  if (status === 'active') return `Ends in ${formatCountdown(Date.parse(sale.endsAt) - serverNow)}`;
  return '';
}
