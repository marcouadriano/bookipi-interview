import { createBackoff, isNoGroupError, type BaseLogger } from '@flashsale/shared/node';

import type { OrderSource } from './ports';
import type { Processor } from './processor';

export interface WorkerOptions {
  reclaimIntervalMs: number;
}

export class Worker {
  private running = true;

  constructor(
    private source: OrderSource,
    private processor: Processor,
    private options: WorkerOptions,
    private log: BaseLogger,
  ) {}

  // Finish the current batch, then `run()` returns.
  stop(): void {
    this.running = false;
  }

  async run(): Promise<void> {
    let groupReady = false;
    let lastReclaim = 0; // reclaim right at startup to pick up a crashed worker's messages
    const backoff = createBackoff();

    while (this.running) {
      try {
        if (!groupReady) {
          await this.source.ensureGroup();
          groupReady = true;
        }

        if (Date.now() - lastReclaim >= this.options.reclaimIntervalMs) {
          await this.reclaimAll();
          lastReclaim = Date.now();
        }

        const entries = await this.source.readNew();
        if (entries.length > 0) await this.processor.process(entries);
        backoff.reset();
      } catch (err) {
        // After Redis loses its data the group is gone; create it again.
        if (isNoGroupError(err)) groupReady = false;
        this.log.error({ err, retryInMs: backoff.delayMs }, 'batch failed; not acknowledged');
        await backoff.wait();
      }
    }
  }

  private async reclaimAll(): Promise<void> {
    let start = '0-0';
    do {
      const page = await this.source.reclaimPage(start);
      if (page.entries.length > 0) {
        this.log.info({ count: page.entries.length }, 'reclaimed idle messages');
        await this.processor.process(page.entries);
      }
      start = page.next;
    } while (start !== '0-0' && this.running);
  }
}
