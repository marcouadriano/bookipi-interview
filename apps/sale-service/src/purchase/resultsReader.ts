import { createBackoff, isNoGroupError, type BaseLogger } from '@flashsale/shared/node';

import type { ResultEntry, ResultSource } from '../ports';
import type { RedisResultApplier } from '../redis/resultApplier';

export class ResultsReader {
  private running = true;

  constructor(
    private source: ResultSource,
    private applier: Pick<RedisResultApplier, 'apply'>,
    private log: BaseLogger,
  ) {}

  // Finish the current batch, then `run()` returns.
  stop(): void {
    this.running = false;
  }

  async run(): Promise<void> {
    let groupReady = false;
    let drainPending = true; // at startup and after an error, first redo what was delivered but not acknowledged
    const backoff = createBackoff();

    while (this.running) {
      try {
        if (!groupReady) {
          await this.source.ensureGroup();
          groupReady = true;
        }

        if (drainPending) {
          const pending = await this.source.readPending();
          if (pending.length === 0) drainPending = false;
          else await this.handle(pending);
        } else {
          await this.handle(await this.source.readNew());
        }
        backoff.reset();
      } catch (err) {
        if (isNoGroupError(err)) groupReady = false;
        drainPending = true;
        this.log.error(
          { err, retryInMs: backoff.delayMs },
          'results batch failed; not acknowledged',
        );
        await backoff.wait();
      }
    }
  }

  private async handle(entries: ResultEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const skipped = entries.filter((e) => !e.result).map((e) => e.id);
    if (skipped.length > 0) this.log.warn({ ids: skipped }, 'skipping malformed results');
    await this.applier.apply(entries.flatMap((e) => (e.result ? [e.result] : [])));
    await this.source.ack(entries.map((e) => e.id));
  }
}
