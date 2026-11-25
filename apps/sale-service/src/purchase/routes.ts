import type { Express } from 'express';

import type { PurchaseOutcome, PurchaseResponse } from '@flashsale/shared';

import { requireUserId, unavailable } from '../http/errors';
import type { UserLimit } from '../http/rateLimit';
import type { RedisPurchases } from '../redis/purchases';

const STATUS: Record<PurchaseOutcome, number> = {
  accepted: 202,
  already_purchased: 409,
  sold_out: 409,
  sale_not_active: 403,
  not_admitted: 403,
};

export function purchaseRoutes(
  app: Express,
  purchases: Pick<RedisPurchases, 'purchase' | 'state'>,
  limitUser: UserLimit,
) {
  app.post('/api/purchase', async (req, res) => {
    const userId = requireUserId(req.body?.userId, res);
    if (!userId) return;
    if (await limitUser(res, userId)) return;

    const result = await purchases.purchase(userId);
    if (result.kind === 'unavailable') return unavailable(res);
    const body: PurchaseResponse = {
      outcome: result.kind,
      userId,
      ...(result.kind === 'sale_not_active' && {
        saleStatus: result.saleStatus,
      }),
    };
    res.status(STATUS[result.kind]).json(body);
  });

  app.get('/api/purchase/:userId', async (req, res) => {
    const userId = requireUserId(req.params.userId, res);
    if (!userId) return;
    res.json(await purchases.state(userId));
  });
}
