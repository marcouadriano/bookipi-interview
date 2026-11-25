import type { SaleStatus } from '@flashsale/shared';

const labels: Record<SaleStatus, string> = {
  upcoming: 'Upcoming',
  active: 'Live',
  ended: 'Ended',
  sold_out: 'Sold out',
};

export function StatusCard({
  status,
  countdown,
}: {
  status: SaleStatus | null;
  countdown: string;
}) {
  return (
    <section className="status" aria-label="Sale status">
      <span className="badge">{status ? labels[status] : 'Loading…'}</span>
      <span className="countdown">{countdown}</span>
    </section>
  );
}
