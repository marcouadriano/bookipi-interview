import pino, { type Logger } from 'pino';

export type { Logger };

// The log methods components need, so they depend on this and not the whole pino `Logger`
export type BaseLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export const createLogger = (): Logger => pino();
