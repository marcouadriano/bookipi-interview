// `pnpm migrate`: runs the .sql files, seeds the sale, and creates the read-only role.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import { loadConfig } from '../src/config';

const config = loadConfig();
const password = process.env.SALE_READER_PASSWORD;
if (!password) {
  console.error('SALE_READER_PASSWORD is required');
  process.exit(1);
}

const dir = join(import.meta.dirname, '..', 'migrations');
const client = new pg.Client({ connectionString: config.databaseUrl });
await client.connect();
try {
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
    console.log(`ran ${file}`);
  }

  await client.query(
    'INSERT INTO sales (id, total_stock) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    [config.saleId, config.totalStock],
  );

  // CREATE ROLE takes a literal, not a parameter.
  const literal = client.escapeLiteral(password);
  const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'sale_reader'");
  if (role.rowCount) {
    await client.query(`ALTER ROLE sale_reader PASSWORD ${literal}`);
  } else {
    await client.query(`CREATE ROLE sale_reader LOGIN PASSWORD ${literal}`);
  }
  await client.query('GRANT SELECT ON sale_buyers TO sale_reader');
  console.log('migrated');
} finally {
  await client.end();
}
