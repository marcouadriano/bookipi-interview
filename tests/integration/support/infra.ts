import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import pg from 'pg';

import { fieldsToObject } from '@flashsale/shared/node';

import { env, streams } from './env';

export const appDir = (name: string) =>
  fileURLToPath(new URL(`../../../apps/${name}`, import.meta.url));

export interface Infra {
  redis: Redis;
  db: pg.Pool;
  close(): Promise<void>;
}

// Connects to the test Redis and Postgres and refuses
// to continue if Redis holds anything that is not ours.
export async function connect(): Promise<Infra> {
  const redis = new Redis(env.redisUrl);
  const db = new pg.Pool({ connectionString: env.databaseUrl });
  const foreign = (await redis.keys('*')).filter((k) => !/^(flashsale:|sale:|ratelimit:)/.test(k));
  if (foreign.length > 0) {
    await redis.quit();
    await db.end();
    throw new Error(
      `Refusing to run: Redis at ${env.redisUrl} holds keys that are not ours (${foreign.slice(0, 3)}). The tests wipe it.`,
    );
  }
  return {
    redis,
    db,
    close: async () => {
      await redis.quit();
      await db.end();
    },
  };
}

// Runs a script of the Order Service (the migration)
// with the test settings. Resolves with its exit code.
function runOrderScript(file: string, totalStock: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', file], {
      cwd: appDir('order-service'),
      env: {
        ...process.env,
        DATABASE_URL: env.databaseUrl,
        SALE_ID: env.saleId,
        TOTAL_STOCK: String(totalStock),
        SALE_READER_PASSWORD: env.readerPassword,
      },
      stdio: 'ignore',
    });
    child.on('exit', resolve);
  });
}

export async function migrate(totalStock = 100): Promise<void> {
  const code = await runOrderScript('scripts/migrate.ts', totalStock);
  if (code !== 0) throw new Error(`migration failed with exit code ${code}`);
}

// Back to a clean slate: empty Redis, no orders, a
// `sales` row with the given stock. Stop every app first.
export async function reset(infra: Infra, totalStock: number): Promise<void> {
  await migrate(totalStock);
  await infra.redis.flushdb();
  await infra.db.query('TRUNCATE orders RESTART IDENTITY');
  await infra.db.query(
    `INSERT INTO sales (id, total_stock, sold) VALUES ($1, $2, 0)
     ON CONFLICT (id) DO UPDATE SET total_stock = $2, sold = 0`,
    [env.saleId, totalStock],
  );
}

export const orderUsers = async (infra: Infra) =>
  (await infra.db.query('SELECT user_id FROM orders ORDER BY order_message_id')).rows.map(
    (r) => r.user_id as string,
  );

export const soldCount = async (infra: Infra) =>
  (await infra.db.query('SELECT sold FROM sales WHERE id = $1', [env.saleId])).rows[0]
    .sold as number;

export async function readStream(infra: Infra, key: string): Promise<Record<string, string>[]> {
  return (await infra.redis.xrange(key, '-', '+')).map(([id, flat]) => ({
    id,
    ...fieldsToObject(flat),
  }));
}

export const resultsFor = async (infra: Infra, userId: string) =>
  (await readStream(infra, streams.results)).filter((r) => r.userId === userId);

export const pendingCount = async (
  infra: Infra,
  stream: string,
  group: string,
): Promise<number> => {
  try {
    return Number(((await infra.redis.xpending(stream, group)) as [number])[0]);
  } catch {
    return 0; // no such group yet
  }
};

// Adds a message to the orders stream the way the Sale Service's Lua script does.
export const addOrder = (infra: Infra, userId: string, saleId = env.saleId) =>
  infra.redis.xadd(
    streams.orders,
    '*',
    'saleId',
    saleId,
    'userId',
    userId,
    'reservedAtMs',
    String(Date.now()),
  ) as Promise<string>;

// Adds a result to the results stream the way the Order Service does.
export const addResult = (
  infra: Infra,
  userId: string,
  status: 'recorded' | 'failed',
  reason?: string,
) =>
  infra.redis.xadd(
    streams.results,
    '*',
    ...Object.entries({
      saleId: env.saleId,
      userId,
      status,
      ...(reason && { reason }),
      orderMessageId: '0-0',
      at: new Date().toISOString(),
    }).flat(),
  ) as Promise<string>;
