import type { PurchaseResponse, QueueStatusResponse } from '@flashsale/shared';

import type { ApiResult } from './api';
import { codeMessage, saleStatusMessage, text, msg, type Message } from './messages';

export type JoinOutcome =
  | { kind: 'queued'; queue: QueueStatusResponse }
  | { kind: 'already_purchased' }
  | { kind: 'sale_not_active' }
  | { kind: 'failed'; message: Message };

export function joinOutcome(res: ApiResult<QueueStatusResponse>): JoinOutcome {
  if (res.status === 200 && res.data) return { kind: 'queued', queue: res.data };
  if (res.code === 'already_purchased') return { kind: 'already_purchased' };
  if (res.code === 'sale_not_active') return { kind: 'sale_not_active' };
  return { kind: 'failed', message: codeMessage(res.code) };
}

export type BuyOutcome =
  | { kind: 'accepted' }
  | { kind: 'already_purchased' }
  | { kind: 'not_admitted' }
  | { kind: 'rejected'; message: Message }
  | { kind: 'failed'; message: Message };

export function buyOutcome(res: ApiResult<PurchaseResponse>): BuyOutcome {
  switch (res.data?.outcome) {
    case 'accepted':
      return { kind: 'accepted' };
    case 'already_purchased':
      return { kind: 'already_purchased' };
    case 'not_admitted':
      return { kind: 'not_admitted' };
    case 'sold_out':
      return { kind: 'rejected', message: msg(text.soldOut) };
    case 'sale_not_active':
      return {
        kind: 'rejected',
        message: saleStatusMessage(res.data.saleStatus),
      };
    default:
      return { kind: 'failed', message: codeMessage(res.code) };
  }
}
