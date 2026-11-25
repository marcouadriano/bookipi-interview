// The invariants a flash sale must keep, whatever the load. A failed check fails the whole run.
import pg from 'pg';

import type { UserResult } from './user';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  note?: boolean; // true: informational, never fails the run
}

export async function verify(
  results: UserResult[],
  opts: {
    stock: number;
    users: number;
    finalSaleStatus: string | undefined;
    databaseUrl?: string;
    saleId: string;
  },
): Promise<Check[]> {
  const checks: Check[] = [];
  const accepted = results.filter((r) => r.accepted);
  const success = results.filter((r) => r.outcome === 'success');
  const check = (name: string, ok: boolean, detail: string, note = false) =>
    checks.push({ name, ok, detail, note });

  check(
    'no oversell: purchases accepted <= stock',
    accepted.length <= opts.stock,
    `${accepted.length} accepted, stock ${opts.stock}`,
  );
  check(
    'no user accepted twice',
    new Set(accepted.map((r) => r.userId)).size === accepted.length,
    `${accepted.length} accepted purchases`,
  );
  check(
    'every accepted purchase was recorded (none failed or stuck)',
    accepted.every((r) => r.outcome === 'success'),
    `${success.length} success, ${accepted.filter((r) => r.outcome === 'failed').length} failed, ${accepted.filter((r) => r.outcome === 'processing_stuck').length} stuck, ${accepted.filter((r) => r.outcome === 'timeout').length} unfinished`,
  );
  check(
    'nobody was left without an answer',
    results.every((r) => r.outcome !== 'timeout'),
    `${results.filter((r) => r.outcome === 'timeout').length} users unfinished when the run ended`,
  );

  if (opts.users >= opts.stock) {
    check(
      'the whole stock was sold',
      accepted.length === opts.stock,
      `${accepted.length} of ${opts.stock} units`,
    );
    check(
      'the sale ended as sold_out',
      opts.finalSaleStatus === 'sold_out',
      `status: ${opts.finalSaleStatus}`,
    );
  } else {
    check(
      'fewer users than stock: expected one purchase each',
      accepted.length === opts.users,
      `${accepted.length} of ${opts.users} users`,
      true,
    );
  }

  if (opts.databaseUrl) {
    const db = new pg.Pool({ connectionString: opts.databaseUrl, max: 2 });
    try {
      const rows = (
        await db.query('SELECT user_id FROM orders WHERE sale_id = $1', [opts.saleId])
      ).rows.map((r) => r.user_id as string);
      const sale = (
        await db.query('SELECT sold, total_stock FROM sales WHERE id = $1', [opts.saleId])
      ).rows[0];

      const inDb = new Set(rows);
      check(
        'Postgres: one order per user',
        inDb.size === rows.length,
        `${rows.length} rows, ${inDb.size} distinct users`,
      );
      check(
        'Postgres: orders == users who were told "success"',
        rows.length === success.length && success.every((r) => inDb.has(r.userId)),
        `${rows.length} rows, ${success.length} success`,
      );
      check(
        'Postgres: nobody has an order without being accepted',
        rows.every((u) => accepted.some((r) => r.userId === u)),
        `${rows.length} rows`,
      );
      check(
        'Postgres: sold == orders and sold <= total_stock',
        sale && sale.sold === rows.length && sale.sold <= sale.total_stock,
        `sold ${sale?.sold}, total_stock ${sale?.total_stock}, rows ${rows.length}`,
      );
    } finally {
      await db.end();
    }
  } else {
    check(
      'Postgres was not checked (no --database-url)',
      true,
      'pass --database-url to compare against the database',
      true,
    );
  }
  return checks;
}
