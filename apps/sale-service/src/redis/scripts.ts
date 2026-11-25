// Registers the Lua scripts once. ioredis calls them by hash (EVALSHA) and resends the
// script itself if Redis lost it (NOSCRIPT).
import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';

type Arg = string | number;
type Reply = (string | number)[];

export interface SaleScripts {
  queueStatus(...args: Arg[]): Promise<Reply>;
  joinQueue(...args: Arg[]): Promise<Reply>;
  popTick(...args: Arg[]): Promise<number>;
  purchase(...args: Arg[]): Promise<Reply>;
}

const read = (file: string) => readFileSync(new URL(`./lua/${file}`, import.meta.url), 'utf8');

export function registerScripts(redis: Redis): Redis & SaleScripts {
  const lib = read('lib.lua');
  const define = (name: keyof SaleScripts, file: string, numberOfKeys: number) =>
    redis.defineCommand(name, { numberOfKeys, lua: `${lib}\n${read(file)}` });

  define('queueStatus', 'queue-status.lua', 3);
  define('joinQueue', 'join.lua', 7);
  define('popTick', 'pop.lua', 6);
  define('purchase', 'purchase.lua', 7);
  return redis as Redis & SaleScripts;
}
