import { createServer, type Server } from 'node:http';

const CHECK_TIMEOUT_MS = 2000;

const withTimeout = <T>(promise: Promise<T>) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS),
    ),
  ]);

type Probe = 'up' | 'down';

// 'up' if `check` finishes within the timeout, 'down' if it throws or is too slow.
const probe = (check: () => Promise<unknown>): Promise<Probe> =>
  withTimeout(check()).then(
    () => 'up',
    () => 'down',
  );

export interface HealthChecks {
  counts(): Promise<{ pendingMessages: number; failedOrders: number }>; // throws if Redis is down
  pingDatabase(): Promise<unknown>; // throws if Postgres is down
}

export function startHealthServer(port: number, checks: HealthChecks): Server {
  return createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.statusCode = 404;
      return res.end();
    }

    let counts = { pendingMessages: 0, failedOrders: 0 };
    const redis = await probe(async () => {
      counts = await checks.counts();
    });
    const postgres = await probe(() => checks.pingDatabase());

    const ok = redis === 'up' && postgres === 'up';
    res.statusCode = ok ? 200 : 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: ok ? 'ok' : 'degraded',
        redis,
        postgres,
        ...counts,
      }),
    );
  }).listen(port);
}
