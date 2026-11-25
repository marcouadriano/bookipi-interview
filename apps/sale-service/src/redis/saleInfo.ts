import type { Redis } from 'ioredis';

import type { SaleStatusResponse } from '@flashsale/shared';

import type { SaleKeys } from '../keys';
import { saleStatusAt } from '../saleStatus';

export interface SaleInfoOptions {
  saleStartMs: number;
  saleEndMs: number;
}

// The sale's status and times, judged by Redis's clock.
export class RedisSaleInfo {
  constructor(
    private redis: Redis,
    private keys: SaleKeys,
    private options: SaleInfoOptions,
  ) {}

  async saleInfo(): Promise<SaleStatusResponse> {
    const [[sec, usec], stock] = await Promise.all([
      this.redis.time(),
      this.redis.get(this.keys.stock),
    ]);
    const now = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
    const { saleStartMs, saleEndMs } = this.options;
    return {
      status: saleStatusAt(now, stock === null ? null : Number(stock), this.options),
      startsAt: new Date(saleStartMs).toISOString(),
      endsAt: new Date(saleEndMs).toISOString(),
      serverTime: new Date(now).toISOString(),
    };
  }
}
