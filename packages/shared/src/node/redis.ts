import type { ChainableCommander, Redis } from 'ioredis';

import type { BaseLogger } from './logger';

// A stream entry as Redis returns it. `fields` is null for an entry that was deleted
export type RawEntry = [id: string, fields: string[] | null];

// `[k1, v1, k2, v2]` to `{ k1: v1, k2: v2 }`
export function fieldsToObject(flat: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

export async function ensureConsumerGroup(
  redis: Redis,
  stream: string,
  group: string,
): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
  } catch (err) {
    if (!String(err).includes('BUSYGROUP')) throw err;
  }
}

// Runs the pipeline and throws the first command error, which `exec()` alone only reports
export async function execPipeline(pipeline: ChainableCommander): Promise<void> {
  for (const [err] of (await pipeline.exec()) ?? []) if (err) throw err;
}

// True when Redis lost the consumer group (after a data loss); the reader should create it again
export const isNoGroupError = (err: unknown): boolean => String(err).includes('NOGROUP');

// Redis clients emit `error` on every failed reconnect; log it as a warning instead of crashing
export function logRedisErrors(log: BaseLogger, ...clients: Redis[]): void {
  for (const client of clients) client.on('error', (err) => log.warn({ err }, 'redis error'));
}
