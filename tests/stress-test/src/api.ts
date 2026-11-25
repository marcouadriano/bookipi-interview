// The Sale Service API as the page calls it, over a keep-alive connection pool, with every call timed.
import http from 'node:http';

import type { Stats } from './stats';

export interface Reply {
  status: number; // 0 = the request failed (timeout, connection refused, ...)
  error?: string; // the error code or message, when status is 0
  body: any;
  retryAfterSec?: number;
}

const failure = (err: Error): Reply => ({
  status: 0,
  body: null,
  error: (err as NodeJS.ErrnoException).code ?? err.message,
});

const REQUEST_TIMEOUT_MS = 15_000;

class Target {
  readonly url: URL;
  readonly agent: http.Agent;
  constructor(base: string, maxSockets: number) {
    this.url = new URL(base);
    this.agent = new http.Agent({ keepAlive: true, maxSockets });
  }
}

export class Api {
  private waitingRoom: Target;
  private purchase: Target;

  constructor(
    waitingRoomUrl: string,
    purchaseUrl: string,
    maxSockets: number,
    private stats: Stats,
  ) {
    this.waitingRoom = new Target(waitingRoomUrl, maxSockets);
    this.purchase = new Target(purchaseUrl, maxSockets);
  }

  sale = () => this.send(this.waitingRoom, 'GET /api/sale', 'GET', '/api/sale');
  join = (userId: string) =>
    this.send(this.waitingRoom, 'POST /api/queue', 'POST', '/api/queue', {
      userId,
    });
  queue = (userId: string) =>
    this.send(
      this.waitingRoom,
      'GET /api/queue/:id',
      'GET',
      `/api/queue/${encodeURIComponent(userId)}`,
    );
  buy = (userId: string) =>
    this.send(this.purchase, 'POST /api/purchase', 'POST', '/api/purchase', {
      userId,
    });
  purchaseState = (userId: string) =>
    this.send(
      this.purchase,
      'GET /api/purchase/:id',
      'GET',
      `/api/purchase/${encodeURIComponent(userId)}`,
    );

  close(): void {
    this.waitingRoom.agent.destroy();
    this.purchase.agent.destroy();
  }

  private send(
    target: Target,
    route: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply> {
    return new Promise((resolve) => {
      const started = performance.now();
      const payload = body === undefined ? undefined : JSON.stringify(body);

      const done = (reply: Reply) => {
        this.stats.record(route, performance.now() - started, reply.status, reply.error);
        resolve(reply);
      };

      const req = http.request(
        {
          hostname: target.url.hostname,
          port: target.url.port,
          path,
          method,
          agent: target.agent,
          headers: payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : undefined,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              // not JSON
            }

            const retryAfter = Number(res.headers['retry-after']);
            done({
              status: res.statusCode ?? 0,
              body: parsed,
              retryAfterSec: Number.isFinite(retryAfter) ? retryAfter : undefined,
            });
          });
          res.on('error', (err) => done(failure(err)));
        },
      );

      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => done(failure(err)));
      if (payload) req.write(payload);
      req.end();
    });
  }
}
