import type { Response } from 'express';

import { normalizeUserId, type ApiErrorCode, type ApiErrorResponse } from '@flashsale/shared';

export function sendError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  retryAfterSec?: number,
) {
  if (retryAfterSec) res.setHeader('Retry-After', String(retryAfterSec));
  const body: ApiErrorResponse = { error: { code, message } };
  res.status(status).json(body);
}

export const invalidUserId = (res: Response) =>
  sendError(res, 400, 'invalid_user_id', 'Enter a valid email or username');

// Sends 400 and returns null when the ID is invalid, so a route can `if (!userId) return;`.
export function requireUserId(raw: unknown, res: Response): string | null {
  const userId = typeof raw === 'string' ? normalizeUserId(raw) : null;
  if (!userId) invalidUserId(res);
  return userId;
}

export const unavailable = (res: Response) =>
  sendError(res, 503, 'temporarily_unavailable', 'Temporarily unavailable', 2);
