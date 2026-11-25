import type { Server } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import { pinoHttp } from 'pino-http';

import type { Logger } from '@flashsale/shared/node';

import type { RateLimiter } from '../ports';
import { invalidUserId, sendError } from './errors';
import { addHealth } from './health';
import { createUserLimit, ipRateLimit, type RateLimitConfig, type UserLimit } from './rateLimit';

export interface AppParts {
  logger: Logger;
  limiter: RateLimiter;
  config: RateLimitConfig;
  routes(app: Express, limitUser: UserLimit): void;
  // Throws when Redis is down; whatever it returns is added to the `/health` response.
  health(): Promise<Record<string, unknown>>;
}

// The middleware both apps share, in order: logs, JSON
// body, IP rate limit, routes, health, then errors.
export function buildApp({ logger, limiter, config, routes, health }: AppParts): Express {
  const app = express();
  app.set('trust proxy', 1); // one hop: the ALB
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '1kb' }));
  app.use(ipRateLimit(limiter, config));
  routes(app, createUserLimit(limiter, config));
  addHealth(app, health);
  addErrorHandling(app, logger);
  return app;
}

// Keeps idle connections open longer than a load balancer's idle timeout (60 s for an AWS ALB).
// Node closes them after 5 s by default, and a request that reuses a connection at that moment
// fails with a connection reset. `headersTimeout` has to stay above `keepAliveTimeout`.
export function keepConnectionsOpen(server: Server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}

function addErrorHandling(app: Express, logger: Logger) {
  app.use((_req, res) => sendError(res, 404, 'not_found', 'Not found'));
  app.use((err: { type?: string }, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') return invalidUserId(res);
    logger.error({ err }, 'unhandled error');
    sendError(res, 500, 'internal', 'Internal error');
  });
}
