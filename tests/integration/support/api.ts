// The Sale Service's HTTP API as the page would call it, plus app shutdown checks.
import assert from 'node:assert/strict';

import { ports, saleKey } from './env';
import { call } from './http';
import type { App } from './proc';
import type { Infra } from './infra';
import { until } from './util';

export const join = (userId: string, port = ports.waitingRoom) =>
  call(port, 'POST', '/api/queue', { userId });
export const queue = (userId: string, port = ports.waitingRoom) =>
  call(port, 'GET', `/api/queue/${encodeURIComponent(userId)}`);
export const buy = (userId: string) => call(ports.purchase, 'POST', '/api/purchase', { userId });
export const purchaseState = (userId: string) =>
  call(ports.purchase, 'GET', `/api/purchase/${encodeURIComponent(userId)}`);
export const saleStatus = async (port = ports.waitingRoom) =>
  (await call(port, 'GET', '/api/sale')).body?.status as string;
export const isReady = async () =>
  (await call(ports.purchase, 'GET', '/health')).body?.ready === true;

export const waitReady = () => until('ready', isReady, 20_000);

// Waits for the ready marker in Redis itself, after a rebuild that the test triggered.
export const waitRebuilt = (infra: Infra, timeoutMs = 10_000) =>
  until('rebuilt', async () => (await infra.redis.exists(saleKey('ready'))) === 1, timeoutMs);

export const waitAdmitted = (userId: string) =>
  until(
    `${userId} to be admitted`,
    async () => (await queue(userId)).body?.state === 'admitted',
    15_000,
  );

// Stops every app, expects a clean exit (0) from each, and no crashes in their logs.
export async function shutdown(apps: App[]) {
  const codes = await Promise.all(apps.map((a) => a.stop()));
  assert.deepEqual(
    codes,
    apps.map(() => 0),
    'every app should exit 0 on SIGTERM',
  );
  for (const a of apps)
    assert.doesNotMatch(
      a.logs(),
      /unhandled|TypeError|ReferenceError/i,
      `${a.name} logged a crash`,
    );
}
