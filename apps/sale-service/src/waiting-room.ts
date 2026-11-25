import { Redis } from 'ioredis';

import { closeServer, createLogger, logRedisErrors, onShutdown } from '@flashsale/shared/node';

import { loadConfig } from './config';
import { buildApp, keepConnectionsOpen } from './http/app';
import { isSaleReady, saleKeys } from './keys';
import { RedisLine } from './redis/line';
import { RedisRateLimiter } from './redis/rateLimiter';
import { RedisSaleInfo } from './redis/saleInfo';
import { registerScripts } from './redis/scripts';
import { PopTimer } from './waiting-room/popTimer';
import { waitingRoomRoutes } from './waiting-room/routes';

const logger = createLogger();
const config = loadConfig();
const redis = registerScripts(new Redis(config.redisUrl));
logRedisErrors(logger, redis);

const keys = saleKeys(config.saleId);
const saleInfo = new RedisSaleInfo(redis, keys, config);
const line = new RedisLine(redis, keys, config);
const limiter = new RedisRateLimiter(redis);

const app = buildApp({
  logger,
  limiter,
  config,
  routes: (app, limitUser) => waitingRoomRoutes(app, saleInfo, line, limitUser),
  health: async () => ({ ready: await isSaleReady(redis, keys) }),
});

const popTimer = new PopTimer(() => line.pop(), config, logger);
popTimer.start();
const server = app.listen(config.waitingRoomPort, () =>
  logger.info({ port: config.waitingRoomPort }, 'waiting room app started'),
);
keepConnectionsOpen(server);

onShutdown(logger, async () => {
  await closeServer(server);
  popTimer.stop();
  await redis.quit();
});
