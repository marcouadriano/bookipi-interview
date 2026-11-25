import type { Redis } from 'ioredis';

import type { FailureReason, SaleStatus, UserPurchaseResponse } from '@flashsale/shared';
import { ORDERS_STREAM } from '@flashsale/shared/node';

import type { SaleKeys } from '../keys';
import type { PurchaseResult } from '../ports';
import type { SaleScripts } from './scripts';

export interface PurchaseOptions {
  saleId: string;
  saleStartMs: number;
  saleEndMs: number;
  admitWindowMs: number;
}

// Buys a unit and reads a user's purchase state.
// `RedisResultApplier` updates that state when results arrive.
export class RedisPurchases {
  constructor(
    private redis: Redis & Pick<SaleScripts, 'purchase'>,
    private keys: SaleKeys,
    private options: PurchaseOptions,
  ) {}

  async purchase(userId: string): Promise<PurchaseResult> {
    const { keys, options } = this;
    const reply = await this.redis.purchase(
      keys.ready,
      keys.stock,
      keys.buyers,
      keys.tickets,
      keys.pops,
      keys.purchases,
      ORDERS_STREAM,
      userId,
      options.saleId,
      options.saleStartMs,
      options.saleEndMs,
      options.admitWindowMs,
    );

    if (reply[0] === 'not_active')
      return { kind: 'sale_not_active', saleStatus: reply[1] as SaleStatus };
    return { kind: reply[0] } as PurchaseResult;
  }

  // Stored as `processing`, `success` or `failed:<reason>`.
  async state(userId: string): Promise<UserPurchaseResponse> {
    const value = await this.redis.hget(this.keys.purchases, userId);
    if (!value) return { userId, state: 'none' };
    if (value.startsWith('failed:')) {
      return {
        userId,
        state: 'failed',
        reason: value.slice('failed:'.length) as FailureReason,
      };
    }
    return { userId, state: value as 'processing' | 'success' };
  }
}
