import type { Express } from 'express';

export function addHealth(app: Express, check: () => Promise<Record<string, unknown>>) {
  app.get('/health', async (_req, res) => {
    try {
      res.json({ status: 'ok', redis: 'up', ...(await check()) });
    } catch {
      res.status(503).json({ status: 'degraded', redis: 'down' });
    }
  });
}
