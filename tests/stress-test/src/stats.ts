// Request counts, status codes and latencies per endpoint, plus requests per second over time.
export class Stats {
  private routes = new Map<string, { ms: number[]; statuses: Map<string, number> }>();
  private perSecond: number[] = [];
  readonly startedAt = Date.now();

  // A failed request has status 0; `error` says why, for example ECONNRESET or timeout.
  record(route: string, ms: number, status: number, error?: string): void {
    let r = this.routes.get(route);
    if (!r) this.routes.set(route, (r = { ms: [], statuses: new Map() }));
    r.ms.push(ms);

    const label = status > 0 ? String(status) : error ? `ERR(${error})` : 'ERR';
    r.statuses.set(label, (r.statuses.get(label) ?? 0) + 1);
    const second = Math.floor((Date.now() - this.startedAt) / 1000);
    this.perSecond[second] = (this.perSecond[second] ?? 0) + 1;
  }

  get totalRequests(): number {
    return [...this.routes.values()].reduce((n, r) => n + r.ms.length, 0);
  }

  // Requests in the last `seconds` whole seconds.
  recentRate(seconds: number): number {
    const now = Math.floor((Date.now() - this.startedAt) / 1000);
    let sum = 0;
    for (let s = now - seconds; s < now; s++) sum += this.perSecond[s] ?? 0;
    return sum / seconds;
  }

  peakRate(): { perSecond: number; atSecond: number } {
    let best = { perSecond: 0, atSecond: 0 };
    this.perSecond.forEach((n, s) => {
      if (n > best.perSecond) best = { perSecond: n, atSecond: s };
    });
    return best;
  }

  table(): {
    route: string;
    count: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    statuses: string;
  }[] {
    return [...this.routes.entries()].map(([route, r]) => {
      const sorted = [...r.ms].sort((a, b) => a - b);
      return {
        route,
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1] ?? 0,
        statuses: [...r.statuses.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([label, n]) => `${label}:${n}`)
          .join(' '),
      };
    });
  }
}

export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.ceil((p / 100) * sortedAscending.length) - 1,
  );
  return sortedAscending[Math.max(0, index)];
}
