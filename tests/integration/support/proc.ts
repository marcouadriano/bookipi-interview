import { spawn } from 'node:child_process';

import { appDir } from './infra';
import { sleep, until } from './util';

export interface App {
  name: string;
  port: number;
  logs(): string;
  // SIGTERM, then wait for the exit code. A process that
  // does not stop in 10 s is killed and gives null.
  stop(): Promise<number | null>;
  crash(): Promise<void>;
}

// Starts a real app process (`node --import tsx <file>`) and waits until `/health` answers.
export async function startApp(
  name: string,
  appName: 'sale-service' | 'order-service',
  file: string,
  port: number,
  env: Record<string, string>,
): Promise<App> {
  let logs = '';
  let exitCode: number | null | undefined;
  const child = spawn(process.execPath, ['--import', 'tsx', file], {
    cwd: appDir(appName),
    env: { ...process.env, NODE_ENV: 'production', ...env },
  });
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  child.on('exit', (code) => (exitCode = code));

  const exited = () => exitCode !== undefined;
  const app: App = {
    name,
    port,
    logs: () => logs,
    async stop() {
      if (exited()) return exitCode ?? null;
      child.kill('SIGTERM');
      const end = Date.now() + 10_000;
      while (!exited() && Date.now() < end) await sleep(50);
      if (!exited()) {
        child.kill('SIGKILL');
        return null;
      }
      return exitCode ?? null;
    },
    async crash() {
      child.kill('SIGKILL');
      while (!exited()) await sleep(20);
    },
  };

  try {
    await until(
      `${name} to answer /health`,
      async () => {
        if (exited()) throw new Error(`${name} exited early with code ${exitCode}:\n${logs}`);
        try {
          return (await fetch(`http://localhost:${port}/health`)).status === 200;
        } catch {
          return false;
        }
      },
      20_000,
    );
  } catch (err) {
    await app.crash();
    throw err;
  }
  return app;
}
