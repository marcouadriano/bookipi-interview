import { percentile, type Stats } from './stats';
import type { Outcome, UserResult } from './user';
import type { Check } from './verify';

const fmt = (n: number, digits = 0) => n.toFixed(digits);
const sec = (ms: number) => `${fmt(ms / 1000, 1)}s`;
const RULE = '─'.repeat(98);

export function tallyOutcomes(results: UserResult[]): Map<Outcome, number> {
  const tally = new Map<Outcome, number>();
  for (const r of results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1);
  return tally;
}

export function progressLine(
  elapsedMs: number,
  results: UserResult[],
  users: number,
  reqPerSec: number,
): string {
  const tally = [...tallyOutcomes(results).entries()].map(([k, v]) => `${k}:${v}`).join(' ') || '-';
  return `[${sec(elapsedMs).padStart(6)}] done ${String(results.length).padStart(6)}/${users}  ${fmt(reqPerSec).padStart(5)} req/s  ${tally}`;
}

export interface ReportInput {
  users: number;
  elapsedMs: number;
  timedOut: boolean;
  stats: Stats;
  results: UserResult[];
  checks: Check[];
}

// Prints the report and returns the exit code: 0 when every invariant held, 1 otherwise.
export function printReport({
  users,
  elapsedMs,
  timedOut,
  stats,
  results,
  checks,
}: ReportInput): number {
  const peak = stats.peakRate();
  console.log(
    `\n${RULE}\nRun: ${sec(elapsedMs)}, ${stats.totalRequests} requests, ${fmt(stats.totalRequests / (elapsedMs / 1000))} req/s on average, peak ${peak.perSecond} req/s (second ${peak.atSecond})`,
  );
  if (timedOut) console.log('The run hit --timeout-seconds before every user finished.');

  console.log(`\nWhat happened to the users`);
  for (const [outcome, n] of [...tallyOutcomes(results).entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outcome.padEnd(18)} ${String(n).padStart(6)}  ${fmt((n / users) * 100, 1)}%`);
  }

  console.log(`\nLatency per endpoint (ms)`);
  console.log(
    `  ${'endpoint'.padEnd(24)}${'count'.padStart(8)}${'p50'.padStart(8)}${'p95'.padStart(8)}${'p99'.padStart(8)}${'max'.padStart(8)}  status codes`,
  );
  for (const r of stats.table()) {
    console.log(
      `  ${r.route.padEnd(24)}${String(r.count).padStart(8)}${fmt(r.p50).padStart(8)}${fmt(r.p95).padStart(8)}${fmt(r.p99).padStart(8)}${fmt(r.max).padStart(8)}  ${r.statuses}`,
    );
  }

  const admit = results
    .flatMap((r) => (r.admittedAfterMs === undefined ? [] : [r.admittedAfterMs]))
    .sort((a, b) => a - b);
  const done = results
    .flatMap((r) => (r.resultAfterMs === undefined ? [] : [r.resultAfterMs]))
    .sort((a, b) => a - b);
  console.log(`\nWhat users waited for (seconds)`);
  console.log(
    `  join to admitted       p50 ${fmt(percentile(admit, 50) / 1000, 1)}  p95 ${fmt(percentile(admit, 95) / 1000, 1)}  max ${fmt(percentile(admit, 100) / 1000, 1)}   (${admit.length} users; set by the admit batch size and interval, and the page's poll)`,
  );
  console.log(
    `  buy to "success"       p50 ${fmt(percentile(done, 50) / 1000, 2)}  p95 ${fmt(percentile(done, 95) / 1000, 2)}  max ${fmt(percentile(done, 100) / 1000, 2)}   (${done.length} users; the Order Service and the page's poll)`,
  );

  console.log(`\nInvariants`);
  for (const c of checks)
    console.log(`  ${c.note ? 'note' : c.ok ? 'PASS'.padEnd(4) : 'FAIL'}  ${c.name} (${c.detail})`);
  const failed = checks.filter((c) => !c.ok && !c.note);
  console.log(
    `${RULE}\n${failed.length === 0 ? 'RESULT: all invariants held' : `RESULT: ${failed.length} invariant(s) FAILED`}`,
  );
  return failed.length === 0 ? 0 : 1;
}
