import { Redis } from 'ioredis';
import pg from 'pg';

import { createLogger, logRedisErrors, onShutdown } from '@flashsale/shared/node';

import { loadConfig } from './config';
import { startHealthServer } from './health';
import { createOrderStore } from './orders';
import { createProcessor } from './processor';
import { OrderStreams } from './streams';
import { Worker } from './worker';

const logger = createLogger();
const config = loadConfig();
const redis = new Redis(config.redisUrl);
const blocking = redis.duplicate();
logRedisErrors(logger, redis, blocking);

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 5000,
});
pool.on('error', (err) => logger.warn({ err }, 'postgres error'));

const streams = new OrderStreams(redis, blocking, config);
const processor = createProcessor(streams, createOrderStore(pool), config, logger);
const worker = new Worker(streams, processor, config, logger);
const health = startHealthServer(config.healthPort, {
  counts: () => streams.counts(),
  pingDatabase: () => pool.query('SELECT 1'),
});

logger.info(
  {
    consumer: config.consumerName,
    healthPort: config.healthPort,
  },
  'Order service started',
);

const running = worker.run();

onShutdown(logger, async () => {
  worker.stop();
  await running; // the current batch finishes first
  health.close();
  await Promise.all([redis.quit(), blocking.quit(), pool.end()]);
});
