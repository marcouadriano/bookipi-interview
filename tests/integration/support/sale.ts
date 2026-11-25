// Starting the Sale Service apps with test settings.
import { env, ports } from './env';
import { startApp, type App } from './proc';

// One sale window for every app in this test process, as in a real deployment where compose passes the
// same SALE_START to every instance. The pop tick is computed from it, so instances must agree.
const startMs = Date.now() - 1000; // a single reading, so the window is exactly one hour
const SALE_START = new Date(startMs).toISOString();
const SALE_END = new Date(startMs + 3600_000).toISOString();

export function saleEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    REDIS_URL: env.redisUrl,
    SALE_ID: env.saleId,
    SALE_START,
    SALE_END,
    TOTAL_STOCK: '3',
    ADMIT_BATCH_SIZE: '2',
    ADMIT_INTERVAL_MS: '1000',
    ADMIT_WINDOW_MS: '4000',
    RATE_LIMIT_USER_MAX: '8',
    RATE_LIMIT_IP_ENABLED: 'false',
    RUN_ID_CHECK_MS: '300',
    SALE_READER_DATABASE_URL: env.readerUrl,
    ...extra,
  };
}

export const startWaitingRoom = (port: number, extra?: Record<string, string>): Promise<App> =>
  startApp(
    `waiting-room:${port}`,
    'sale-service',
    'src/waiting-room.ts',
    port,
    saleEnv({ WAITING_ROOM_PORT: String(port), ...extra }),
  );

export const startPurchase = (port: number, extra?: Record<string, string>): Promise<App> =>
  startApp(
    `purchase:${port}`,
    'sale-service',
    'src/purchase.ts',
    port,
    saleEnv({ PURCHASE_PORT: String(port), ...extra }),
  );

// The real Order Service worker, with short timings so reclaim happens quickly.
export const startOrderWorker = (extra: Record<string, string> = {}): Promise<App> =>
  startApp('order-service', 'order-service', 'src/index.ts', ports.orderHealth, {
    REDIS_URL: env.redisUrl,
    DATABASE_URL: env.databaseUrl,
    SALE_ID: env.saleId,
    HEALTH_PORT: String(ports.orderHealth),
    BLOCK_MS: '300',
    RECLAIM_IDLE_MS: '1500',
    RECLAIM_INTERVAL_MS: '500',
    ...extra,
  });
