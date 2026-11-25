import { Redis } from 'ioredis';

import { closeServer, createLogger, logRedisErrors, onShutdown } from '@flashsale/shared/node';

import { loadConfig, loadReaderDatabaseUrl } from './config';
import { buildApp, keepConnectionsOpen } from './http/app';
import { isSaleReady, saleKeys } from './keys';
import { PostgresBuyerSource } from './purchase/pgBuyers';
import { Rebuilder } from './purchase/rebuilder';
import { ResultsReader } from './purchase/resultsReader';
import { purchaseRoutes } from './purchase/routes';
import { RedisPurchases } from './redis/purchases';
import { RedisRateLimiter } from './redis/rateLimiter';
import { RedisResultApplier } from './redis/resultApplier';
import { RedisResultStream } from './redis/results';
import { registerScripts } from './redis/scripts';

const logger = createLogger();
const config = loadConfig();
const readerDatabaseUrl = loadReaderDatabaseUrl();
const keys = saleKeys(config.saleId);

const redis = registerScripts(new Redis(config.redisUrl));
const blocking = redis.duplicate(); // the results reader's blocking read has its own connection
logRedisErrors(logger, redis, blocking);

const purchases = new RedisPurchases(redis, keys, config);
const results = new RedisResultStream(redis, blocking);
const applier = new RedisResultApplier(redis, keys, config);
const limiter = new RedisRateLimiter(redis);

const app = buildApp({
  logger,
  limiter,
  config,
  routes: (app, limitUser) => purchaseRoutes(app, purchases, limitUser),
  health: async () => ({
    ready: await isSaleReady(redis, keys),
    resultsBacklog: await results.backlog().catch(() => null), // null when the backlog cannot be read, e.g. the group is not created yet
  }),
});

const rebuilder = new Rebuilder(
  redis,
  keys,
  new PostgresBuyerSource(readerDatabaseUrl),
  config,
  logger,
);
const reader = new ResultsReader(results, applier, logger);
rebuilder.start();
const reading = reader.run();
const server = app.listen(config.purchasePort, () =>
  logger.info({ port: config.purchasePort }, 'purchase app started'),
);
keepConnectionsOpen(server);

onShutdown(logger, async () => {
  await closeServer(server);
  rebuilder.stop();
  reader.stop();
  await reading;
  await Promise.all([redis.quit(), blocking.quit()]);
});
