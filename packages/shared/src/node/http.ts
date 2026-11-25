import type { Server } from 'node:http';

export const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));
