// Fixed-window rate limits. Over the limit: 429 with Retry-After.
import type { Request, RequestHandler, Response } from 'express';

import type { Config } from '../config';
import { rateLimitKey } from '../keys';
import type { RateLimiter } from '../ports';
import { sendError } from './errors';

type IpLimitConfig = Pick<Config, 'rateLimitIpEnabled' | 'rateLimitIpMax' | 'rateLimitIpWindowMs'>;
type UserLimitConfig = Pick<Config, 'rateLimitUserMax' | 'rateLimitUserWindowMs'>;
export type RateLimitConfig = IpLimitConfig & UserLimitConfig;

// Per IP, on every endpoint except `/health`. Does nothing when RATE_LIMIT_IP_ENABLED=false.
export function ipRateLimit(limiter: RateLimiter, config: IpLimitConfig): RequestHandler {
  return async (req: Request, res: Response, next) => {
    if (!config.rateLimitIpEnabled || req.path === '/health') return next();
    const { allowed, retryAfterSec } = await limiter.hit(
      rateLimitKey('ip', req.ip ?? 'unknown'),
      config.rateLimitIpMax,
      config.rateLimitIpWindowMs,
    );
    if (allowed) return next();
    sendError(res, 429, 'rate_limited', 'Too many requests', retryAfterSec);
  };
}

// Per user ID, for the POST endpoints. Returns true when it already sent the 429.
export type UserLimit = (res: Response, userId: string) => Promise<boolean>;

export function createUserLimit(limiter: RateLimiter, config: UserLimitConfig): UserLimit {
  return async (res, userId) => {
    const { allowed, retryAfterSec } = await limiter.hit(
      rateLimitKey('user', userId),
      config.rateLimitUserMax,
      config.rateLimitUserWindowMs,
    );
    if (!allowed) sendError(res, 429, 'rate_limited', 'Too many attempts', retryAfterSec);
    return !allowed;
  };
}
