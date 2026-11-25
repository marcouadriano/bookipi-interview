import { FAILED_ORDERS_STREAM, ORDERS_STREAM, ORDER_RESULTS_STREAM } from '@flashsale/shared/node';

import { saleKeys, type SaleKeys } from '../../../apps/sale-service/src/keys';

// Where the tests run. The defaults are the throwaway containers in docker-compose.test.yml.
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:16380';
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:15433/flashsale_test';

// The tests wipe this database. Refuse anything that does not look like a test database.
const dbName = new URL(databaseUrl).pathname.slice(1);
if (!/test/i.test(dbName)) {
  throw new Error(
    `Refusing to run: the database name must contain "test" (got "${dbName}"). The tests wipe it.`,
  );
}

export const env = {
  redisUrl,
  databaseUrl,
  saleId: 'test-sale',
  readerPassword: 'readerpw',
  // Same database, as the read-only `sale_reader` role.
  readerUrl: databaseUrl.replace(/\/\/[^@]+@/, '//sale_reader:readerpw@'),
};

export const streams = {
  orders: ORDERS_STREAM,
  results: ORDER_RESULTS_STREAM,
  failed: FAILED_ORDERS_STREAM,
};

export const saleKey = (name: keyof SaleKeys) => saleKeys(env.saleId)[name];

// Test ports are far from the dev ports (3000, 3001, 3002) so a running dev stack does not interfere.
export const ports = {
  waitingRoom: 4000,
  waitingRoom2: 4010,
  waitingRoom3: 4020,
  purchase: 4002,
  purchase2: 4012,
  orderHealth: 4001,
};
