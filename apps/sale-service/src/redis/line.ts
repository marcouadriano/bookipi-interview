import type { Redis } from 'ioredis';

import type { QueueStatusResponse } from '@flashsale/shared';

import type { SaleKeys } from '../keys';
import type { JoinResult } from '../ports';
import type { SaleScripts } from './scripts';

export interface LineOptions {
  saleStartMs: number;
  saleEndMs: number;
  admitBatchSize: number;
  admitIntervalMs: number;
  admitWindowMs: number;
}

export class RedisLine {
  constructor(
    private redis: Redis & Pick<SaleScripts, 'joinQueue' | 'queueStatus' | 'popTick'>,
    private keys: SaleKeys,
    private options: LineOptions,
  ) {}

  async join(userId: string): Promise<JoinResult> {
    const { keys, options } = this;
    const reply = await this.redis.joinQueue(
      keys.ready,
      keys.stock,
      keys.buyers,
      keys.tickets,
      keys.pops,
      keys.last,
      keys.serving,
      userId,
      options.saleStartMs,
      options.saleEndMs,
      options.admitWindowMs,
    );

    switch (reply[0]) {
      case 'unavailable':
        return { kind: 'unavailable' };
      case 'purchased':
        return { kind: 'already_purchased' };
      case 'inactive':
        return { kind: 'sale_not_active' };
      default:
        return { kind: 'queued', status: this.toStatus(userId, reply) };
    }
  }

  async status(userId: string): Promise<QueueStatusResponse | null> {
    const { keys, options } = this;
    const reply = await this.redis.queueStatus(
      keys.tickets,
      keys.pops,
      keys.serving,
      userId,
      options.admitWindowMs,
    );
    return reply[0] === 'none' ? null : this.toStatus(userId, reply);
  }

  // Pops the current tick if nobody has yet. Returns how many users were admitted.
  pop(): Promise<number> {
    const { keys, options } = this;
    return this.redis.popTick(
      keys.ready,
      keys.stock,
      keys.last,
      keys.serving,
      keys.lastTick,
      keys.pops,
      options.saleStartMs,
      options.saleEndMs,
      options.admitIntervalMs,
      options.admitBatchSize,
    );
  }

  // reply = [state, ticket, serving, windowEnd]
  private toStatus(userId: string, reply: (string | number)[]): QueueStatusResponse {
    const [state, , , windowEnd] = reply as [QueueStatusResponse['state'], number, number, number];
    return state === 'admitted'
      ? { userId, state, admittedUntil: new Date(windowEnd).toISOString() }
      : { userId, state };
  }
}
