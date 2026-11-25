// Stress test for the Sale Service. Calls the Waiting Room app and the Purchase app directly,
// with many virtual users that behave like the page, then checks the invariants of the sale.
// Run the stack with RATE_LIMIT_IP_ENABLED=false: every virtual user comes from this one machine.
import { Api } from './api';
import { parseOptions, UsageError, type Options } from './options';
import { printReport, progressLine } from './report';
import { Stats } from './stats';
import { runUser, type Run, type UserResult } from './user';
import { verify } from './verify';

const PROGRESS_EVERY_MS = 5000;

// Exit code 2 and a message when the stack is not up or
// the sale is not open; null when the run can start.
async function checkSaleIsOpen(api: Api, options: Options): Promise<number | null> {
  const first = await api.sale();
  if (first.status !== 200) {
    console.error(
      `Cannot reach the Waiting Room app at ${options.waitingRoomUrl} (status ${first.status}). Is the stack running?`,
    );
    return 2;
  }
  if (first.body.status !== 'active') {
    console.error(
      `The sale is "${first.body.status}", not active. Start the stack with a sale window that includes now.`,
    );
    return 2;
  }
  return null;
}

// Runs every virtual user, printing progress, until all finish or the timeout stops them.
async function runUsers(api: Api, stats: Stats, options: Options, run: Run): Promise<UserResult[]> {
  const results: UserResult[] = [];
  const startedAt = Date.now();
  const progress = setInterval(
    () =>
      console.log(
        progressLine(Date.now() - startedAt, results, options.users, stats.recentRate(5)),
      ),
    PROGRESS_EVERY_MS,
  );
  const hardStop = setTimeout(() => (run.stopped = true), options.timeoutMs);

  await Promise.all(
    Array.from({ length: options.users }, (_, i) =>
      runUser(i, api, run).then((r) => void results.push(r)),
    ),
  );
  clearInterval(progress);
  clearTimeout(hardStop);
  return results;
}

async function main(): Promise<number> {
  const options = parseOptions();
  const stats = new Stats();
  const api = new Api(options.waitingRoomUrl, options.purchaseUrl, options.maxSockets, stats);
  const notReady = await checkSaleIsOpen(api, options);
  if (notReady !== null) return notReady;

  console.log(
    `Stress test: ${options.users} users, ramp ${options.rampMs / 1000}s, stock ${options.stock}`,
  );
  console.log(`  waiting room ${options.waitingRoomUrl}, purchase ${options.purchaseUrl}\n`);

  const run: Run = { stopped: false, rampMs: options.rampMs };
  const startedAt = Date.now();
  const results = await runUsers(api, stats, options, run);
  const elapsedMs = Date.now() - startedAt;

  const finalSaleStatus = (await api.sale()).body?.status as string | undefined;
  const checks = await verify(results, {
    stock: options.stock,
    users: options.users,
    finalSaleStatus,
    databaseUrl: options.databaseUrl,
    saleId: options.saleId,
  });
  api.close();

  return printReport({
    users: options.users,
    elapsedMs,
    timedOut: run.stopped,
    stats,
    results,
    checks,
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof UsageError ? err.message : err);
    process.exit(2);
  },
);
