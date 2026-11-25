import type { Redis } from 'ioredis';

import { execPipeline, type OrderResult } from '@flashsale/shared/node';

import type { SaleKeys } from '../keys';

// Writes the Order Service's results into the purchase states. Repeats are harmless.
export class RedisResultApplier {
  constructor(
    private redis: Redis,
    private keys: SaleKeys,
    private options: { saleId: string },
  ) {}

  async apply(results: OrderResult[]): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const r of results.filter((x) => x.saleId === this.options.saleId)) {
      if (r.status === 'recorded') {
        pipeline.hset(this.keys.purchases, r.userId, 'success');
      } else {
        pipeline.hset(this.keys.purchases, r.userId, `failed:${r.reason ?? 'processing_error'}`);
        // Postgres is the source of truth: it is out of stock, so the sale is over.
        if (r.reason === 'sold_out') pipeline.set(this.keys.stock, 0);
      }
    }
    await execPipeline(pipeline);
  }
}
