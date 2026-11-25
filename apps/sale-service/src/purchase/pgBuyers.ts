import pg from 'pg';

import type { BuyerSource } from '../ports';

// Reads who bought, through the read-only view. Opens a connection, runs one query, closes it.
export class PostgresBuyerSource implements BuyerSource {
  constructor(private databaseUrl: string) {}

  async buyers(saleId: string): Promise<string[]> {
    const client = new pg.Client({
      connectionString: this.databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      const res = await client.query('SELECT user_id FROM sale_buyers WHERE sale_id = $1', [
        saleId,
      ]);
      return res.rows.map((r) => r.user_id as string);
    } finally {
      await client.end();
    }
  }
}
