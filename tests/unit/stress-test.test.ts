// The stress test's own logic: it must flag a bad result, or a green run proves nothing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UsageError, parseOptions } from '../stress-test/src/options';
import { Stats, percentile } from '../stress-test/src/stats';
import type { UserResult } from '../stress-test/src/user';
import { verify } from '../stress-test/src/verify';

describe('percentile', () => {
  it('is 0 for no data', () => assert.equal(percentile([], 95), 0));
  it('picks the nearest-rank value', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.deepEqual(
      [50, 95, 99, 100].map((p) => percentile(v, p)),
      [50, 95, 99, 100],
    );
    assert.equal(percentile([10, 20], 0), 10);
    assert.equal(percentile([7], 99), 7);
  });
});

describe('Stats', () => {
  it('counts requests, status codes and latencies per route', () => {
    const s = new Stats();
    s.record('GET /a', 10, 200);
    s.record('GET /a', 30, 200);
    s.record('GET /a', 20, 429);
    s.record('POST /b', 5, 0);
    assert.equal(s.totalRequests, 4);
    const a = s.table().find((r) => r.route === 'GET /a');
    assert.deepEqual([a?.count, a?.max, a?.p50, a?.statuses], [3, 30, 20, '200:2 429:1']);
    assert.equal(s.table().find((r) => r.route === 'POST /b')?.statuses, 'ERR:1'); // status 0 is a network error
    assert.equal(s.peakRate().perSecond, 4);
  });

  it('names the error behind a failed request', () => {
    const s = new Stats();
    s.record('GET /a', 5, 200);
    s.record('GET /a', 5, 0, 'ECONNRESET');
    s.record('GET /a', 5, 0, 'ECONNRESET');
    s.record('GET /a', 5, 0, 'timeout');
    assert.equal(s.table()[0].statuses, '200:1 ERR(ECONNRESET):2 ERR(timeout):1');
  });
});

describe('verify', () => {
  const user = (userId: string, outcome: UserResult['outcome'], accepted: boolean): UserResult => ({
    userId,
    outcome,
    accepted,
    rejoins: 0,
  });
  const opts = { stock: 2, users: 5, finalSaleStatus: 'sold_out', saleId: 's' };
  const failing = async (results: UserResult[], o = opts) =>
    (await verify(results, o)).filter((c) => !c.ok).map((c) => c.name);

  const good = [
    user('a', 'success', true),
    user('b', 'success', true),
    user('c', 'sold_out', false),
    user('d', 'sold_out', false),
    user('e', 'sold_out', false),
  ];

  it('passes a correct run', async () => assert.deepEqual(await failing(good), []));

  it('flags overselling', async () => {
    const bad = [...good, user('f', 'success', true)];
    assert.ok((await failing(bad)).some((n) => n.startsWith('no oversell')));
  });

  it('flags the same user accepted twice', async () => {
    const bad = [user('a', 'success', true), user('a', 'success', true)];
    assert.ok((await failing(bad)).includes('no user accepted twice'));
  });

  it('flags an accepted purchase that failed, got stuck or never finished', async () => {
    for (const outcome of ['failed', 'processing_stuck', 'timeout'] as const) {
      const bad = [user('a', 'success', true), user('b', outcome, true), ...good.slice(2)];
      assert.ok(
        (await failing(bad)).some((n) => n.startsWith('every accepted purchase')),
        outcome,
      );
    }
  });

  it('flags a user left without an answer', async () => {
    const bad = [...good.slice(0, 4), user('e', 'timeout', false)];
    assert.ok((await failing(bad)).includes('nobody was left without an answer'));
  });

  it('flags unsold stock and a sale that did not end as sold_out', async () => {
    const unsold = [user('a', 'success', true), ...good.slice(2)];
    assert.ok((await failing(unsold)).includes('the whole stock was sold'));
    assert.ok(
      (await failing(good, { ...opts, finalSaleStatus: 'active' })).includes(
        'the sale ended as sold_out',
      ),
    );
  });

  it('only notes, and does not fail, when there are fewer users than stock', async () => {
    const checks = await verify([user('a', 'success', true)], {
      ...opts,
      stock: 10,
      users: 1,
    });
    assert.equal(
      checks.every((c) => c.ok),
      true,
    );
  });
});

describe('parseOptions', () => {
  it('applies the defaults', () => {
    const o = parseOptions([]);
    assert.deepEqual([o.users, o.rampMs, o.stock], [2000, 10_000, 100]);
  });

  it('reads overrides, with fractional seconds allowed', () => {
    const o = parseOptions(['--users', '5000', '--ramp-seconds', '2.5', '--stock', '10']);
    assert.deepEqual([o.users, o.rampMs, o.stock], [5000, 2500, 10]);
  });

  it('rejects a typo or a zero instead of running no load and reporting a pass', () => {
    for (const args of [
      ['--users', '2o000'],
      ['--users', '0'],
      ['--stock', '0'],
      ['--timeout-seconds', '0'],
      ['--max-sockets=-1'], // the `=` form: the parser rejects `--max-sockets -1` itself
    ]) {
      assert.throws(() => parseOptions(args), UsageError, args.join(' '));
    }
  });
});
