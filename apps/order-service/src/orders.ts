// All SQL for writing orders. Plain SQL, no ORM.
import type { Pool } from 'pg';

import type { NewOrder, OrderStore, RecordOutcome } from './ports';

export function createOrderStore(pool: Pool): OrderStore {
  // One transaction: insert the orders (a repeat is ignored), then add the
  // newly inserted count to `sales.sold` only if it stays within `total_stock`.
  async function recordOrders(saleId: string, orders: NewOrder[]): Promise<RecordOutcome> {
    const client = await pool.connect();
    let broken = false;

    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO orders (sale_id, user_id, reserved_at, order_message_id)
         SELECT $1::text, t.user_id, t.reserved_at, t.message_id
         FROM unnest($2::text[], $3::timestamptz[], $4::text[]) AS t(user_id, reserved_at, message_id)
         ON CONFLICT DO NOTHING
         RETURNING order_message_id`,
        [
          saleId,
          orders.map((o) => o.userId),
          orders.map((o) => o.reservedAt),
          orders.map((o) => o.messageId),
        ],
      );

      const k = inserted.rowCount ?? 0;
      if (k > 0) {
        const updated = await client.query(
          'UPDATE sales SET sold = sold + $2::int WHERE id = $1 AND sold + $2::int <= total_stock',
          [saleId, k],
        );
        if (updated.rowCount === 0) {
          await client.query('ROLLBACK');
          return 'out_of_stock';
        }
      }

      await client.query('COMMIT');
      return 'recorded';
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // the pool drops this connection instead of reusing it
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  return { recordOrders };
}
