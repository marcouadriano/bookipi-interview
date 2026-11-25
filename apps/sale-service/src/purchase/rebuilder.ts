import type { Redis } from 'ioredis';

import { createBackoff, execPipeline, type BaseLogger } from '@flashsale/shared/node';

import { isSaleReady, type SaleKeys } from '../keys';
import type { BuyerSource } from '../ports';
import { RedisLock } from '../redis/lock';

export interface RebuildOptions {
  saleId: string;
  totalStock: number;
  runIdCheckMs: number;
}

const CHUNK = 1000;
const LOCK_MS = 60_000;

export class Rebuilder {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private lastRunId: string | null = null;
  private retryAt = 0;
  private backoff = createBackoff(1000, 30_000);
  private lock: RedisLock;

  constructor(
    private redis: Redis,
    private keys: SaleKeys,
    private source: BuyerSource,
    private options: RebuildOptions,
    private log: BaseLogger,
  ) {
    this.lock = new RedisLock(redis, keys.rebuildLock, LOCK_MS);
  }

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.options.runIdCheckMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // Rebuild at startup, when Redis's run_id changes (restart
  // or failover), or when the ready marker is gone.
  async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const runId = (await this.redis.info('server')).match(/run_id:(\S+)/)?.[1] ?? '';
      const ready = await isSaleReady(this.redis, this.keys);
      if (runId === this.lastRunId && ready) return;
      if (Date.now() < this.retryAt) return;
      try {
        // Does nothing when another instance holds the lock: that one is on it.
        await this.lock.run(() => this.fillFromPostgres());
        // Recorded even when another instance held the lock and did the work. If that one fails,
        // the ready marker stays missing and a later check rebuilds.
        this.lastRunId = runId;
        this.backoff.reset();
      } catch (err) {
        const retryInMs = this.backoff.advance();
        this.log.error({ err, retryInMs }, 'rebuild failed; the ready marker stays missing');
        this.retryAt = Date.now() + retryInMs;
      }
    } catch (err) {
      this.log.warn({ err }, 'rebuild check failed');
    } finally {
      this.busy = false;
    }
  }

  private async fillFromPostgres(): Promise<void> {
    const { redis, keys, options } = this;
    await redis.del(keys.ready);
    const fromPostgres = await this.source.buyers(options.saleId);

    // Never remove anyone: Redis may hold accepted purchases that are not in Postgres yet.
    for (let i = 0; i < fromPostgres.length; i += CHUNK) {
      const chunk = fromPostgres.slice(i, i + CHUNK);
      await execPipeline(
        redis
          .multi()
          .sadd(keys.buyers, ...chunk)
          .hset(keys.purchases, ...chunk.flatMap((user) => [user, 'success'])),
      );
    }
    const buyers = await redis.scard(keys.buyers);
    await redis.set(keys.stock, Math.max(0, options.totalStock - buyers));
    await redis.set(keys.ready, '1');
    this.log.info(
      { buyers, fromPostgres: fromPostgres.length },
      'rebuilt from Postgres; sale is ready',
    );
  }
}
