import type { BaseLogger } from './logger';

export function onShutdown(log: BaseLogger, stop: () => Promise<void>) {
  let stopping = false;
  const handler = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    stop().then(
      () => process.exit(0),
      (err) => {
        log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
