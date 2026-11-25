import type { Express } from 'express';

import { requireUserId, sendError, unavailable } from '../http/errors';
import type { UserLimit } from '../http/rateLimit';
import type { RedisLine } from '../redis/line';
import type { RedisSaleInfo } from '../redis/saleInfo';

export function waitingRoomRoutes(
  app: Express,
  sale: Pick<RedisSaleInfo, 'saleInfo'>,
  line: Pick<RedisLine, 'join' | 'status'>,
  limitUser: UserLimit,
) {
  app.get('/api/sale', async (_req, res) => {
    res.json(await sale.saleInfo());
  });

  app.post('/api/queue', async (req, res) => {
    const userId = requireUserId(req.body?.userId, res);
    if (!userId) return;
    if (await limitUser(res, userId)) return;

    const result = await line.join(userId);
    switch (result.kind) {
      case 'unavailable':
        return unavailable(res);
      case 'already_purchased':
        return sendError(res, 409, 'already_purchased', 'Already purchased');
      case 'sale_not_active':
        return sendError(res, 403, 'sale_not_active', 'The sale is not active');
      case 'queued':
        return void res.json(result.status);
    }
  });

  app.get('/api/queue/:userId', async (req, res) => {
    const userId = requireUserId(req.params.userId, res);
    if (!userId) return;
    const status = await line.status(userId);
    if (!status) return sendError(res, 404, 'not_found', 'Not in line');
    res.json(status);
  });
}
