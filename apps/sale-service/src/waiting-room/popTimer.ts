import type { BaseLogger } from '@flashsale/shared/node';

export interface PopTimerOptions {
  admitIntervalMs: number;
}

// Every instance runs this timer. The Lua script pops each tick only
// once, so extra calls do nothing. It calls more often than once per
// admit interval so that timer jitter can never skip a tick.
export class PopTimer {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private pop: () => Promise<number>,
    private options: PopTimerOptions,
    private log: BaseLogger,
  ) {}

  start(): void {
    const everyMs = Math.max(50, Math.floor(this.options.admitIntervalMs / 4));
    this.timer = setInterval(() => void this.tick(), everyMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const popped = await this.pop();
      if (popped > 0) this.log.info({ popped }, 'admitted users');
    } catch (err) {
      this.log.warn({ err }, 'pop failed; the next call retries');
    }
  }
}
