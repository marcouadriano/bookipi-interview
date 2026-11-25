// `pnpm dev`: starts both apps with one shared sale window (now to now + 1 hour) unless
// SALE_START / SALE_END are already set. Needs SALE_READER_DATABASE_URL for the Purchase app.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const now = Date.now();
const env = {
  ...process.env,
  SALE_START: process.env.SALE_START ?? new Date(now).toISOString(),
  SALE_END: process.env.SALE_END ?? new Date(now + 60 * 60 * 1000).toISOString(),
};
console.log(`sale window: ${env.SALE_START} to ${env.SALE_END}`);

const tsx = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
const root = join(import.meta.dirname, '..');
const children = ['waiting-room', 'purchase'].map((app) =>
  spawn(tsx, [join('src', `${app}.ts`)], { cwd: root, env, stdio: 'inherit' }),
);

const stopAll = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
children.forEach((c) =>
  c.on('exit', (code) => {
    stopAll();
    process.exit(code ?? 0);
  }),
);
