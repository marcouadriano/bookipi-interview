// One virtual user, behaving like the page: join the line, poll the sale and the place in line,
// buy as soon as admitted, then poll the purchase until it has a result or the time limit passes.
// The polling intervals come from `@flashsale/shared`, the same ones the page uses.
import { PURCHASE_POLL_MS, PURCHASE_PROCESSING_LIMIT_MS, QUEUE_POLL_MS } from '@flashsale/shared';
import { sleep } from '@flashsale/shared/node';

import type { Api } from './api';

export type Outcome =
  | 'success' // bought, and the order was recorded in Postgres
  | 'failed' // bought, but the order could not be recorded
  | 'sold_out' // admitted, but the stock was gone
  | 'never_admitted' // the sale ended or sold out while waiting
  | 'not_admitted' // tried to buy outside the window
  | 'processing_stuck' // accepted, but no result within the processing time limit
  | 'refused' // an unexpected refusal
  | 'timeout'; // the test run ended first

export interface UserResult {
  userId: string;
  outcome: Outcome;
  accepted: boolean; // the Purchase app answered 202 accepted
  admittedAfterMs?: number; // join to the moment the user saw "admitted"
  resultAfterMs?: number; // buy to the moment the user saw success or failed
  rejoins: number;
}

export interface Run {
  stopped: boolean;
  rampMs: number;
}

const MAX_REJOINS = 3;
const MAX_TRIES = 30;
const MAX_BUY_ATTEMPTS = 5;

export async function runUser(index: number, api: Api, run: Run): Promise<UserResult> {
  const result: UserResult = {
    userId: `stress-${index}`,
    outcome: 'timeout',
    accepted: false,
    rejoins: 0,
  };
  const { userId } = result;
  await sleep(Math.random() * run.rampMs);

  const joinedAt = Date.now();
  const admission = await waitForAdmission(api, userId, run);
  result.rejoins = admission.rejoins;
  if (admission.outcome !== 'admitted') return { ...result, outcome: admission.outcome };
  result.admittedAfterMs = Date.now() - joinedAt;

  const boughtAt = Date.now();
  const bought = await buy(api, userId, run);
  if (bought !== 'accepted') return { ...result, outcome: bought };
  result.accepted = true;

  return { ...result, ...(await waitForResult(api, userId, run, boughtAt)) };
}

// Joins the line and polls until admitted. Any other outcome ends the user's run.
async function waitForAdmission(
  api: Api,
  userId: string,
  run: Run,
): Promise<{ outcome: 'admitted' | Outcome; rejoins: number }> {
  let rejoins = 0;
  let state = await join(api, userId, run);
  while (!run.stopped) {
    if (state === 'closed') return { outcome: 'never_admitted', rejoins };
    if (state === 'refused') return { outcome: 'refused', rejoins };
    if (state === 'admitted') break;

    await sleep(QUEUE_POLL_MS + Math.random() * 500);
    if (run.stopped) break;
    const [sale, queue] = await Promise.all([api.sale(), api.queue(userId)]);
    const queueState = queue.body?.state;
    if (queueState === 'admitted') {
      state = 'admitted';
    } else if (queueState === 'expired') {
      if (++rejoins > MAX_REJOINS) return { outcome: 'never_admitted', rejoins };
      state = await join(api, userId, run);
    } else if (sale.body?.status === 'sold_out' || sale.body?.status === 'ended') {
      return { outcome: 'never_admitted', rejoins };
    }
  }
  return { outcome: run.stopped ? 'timeout' : 'admitted', rejoins };
}

// Tries to buy, retrying while the server asks us to
// wait. `accepted`, or the outcome that ends the run.
async function buy(api: Api, userId: string, run: Run): Promise<'accepted' | Outcome> {
  for (let attempt = 0; attempt < MAX_BUY_ATTEMPTS && !run.stopped; attempt++) {
    const bought = await api.buy(userId);
    const outcome = bought.body?.outcome;
    if (bought.status === 202 && outcome === 'accepted') return 'accepted';
    if (outcome === 'sold_out') return 'sold_out';
    if (outcome === 'not_admitted') return 'not_admitted';
    if (outcome === 'sale_not_active') return 'never_admitted';
    if (outcome === 'already_purchased') {
      // An earlier attempt may have been accepted although its reply was lost. Check, do not assume.
      const state = (await api.purchaseState(userId)).body?.state;
      return state === 'processing' || state === 'success' ? 'accepted' : 'refused';
    }
    await sleep((bought.retryAfterSec ?? 1) * 1000); // 429, 503 or a failed request: try again
  }
  return run.stopped ? 'timeout' : 'refused';
}

// Polls the purchase until it succeeds or fails, or the time limit passes.
async function waitForResult(
  api: Api,
  userId: string,
  run: Run,
  boughtAt: number,
): Promise<Pick<UserResult, 'outcome' | 'resultAfterMs'>> {
  const waitUntil = Date.now() + PURCHASE_PROCESSING_LIMIT_MS;
  while (!run.stopped && Date.now() < waitUntil) {
    await sleep(PURCHASE_POLL_MS);
    const state = (await api.purchaseState(userId)).body?.state;
    if (state === 'success' || state === 'failed')
      return { outcome: state, resultAfterMs: Date.now() - boughtAt };
  }
  return { outcome: run.stopped ? 'timeout' : 'processing_stuck' };
}

// 'admitted' | 'waiting' | 'closed' (sale not active) |
// 'refused'. Retries while the server asks us to wait.
async function join(
  api: Api,
  userId: string,
  run: Run,
): Promise<'admitted' | 'waiting' | 'closed' | 'refused'> {
  for (let attempt = 0; attempt < MAX_TRIES && !run.stopped; attempt++) {
    const reply = await api.join(userId);
    if (reply.status === 200) return reply.body?.state === 'admitted' ? 'admitted' : 'waiting';
    if (reply.status === 403) return 'closed';
    if (reply.status === 409) return 'refused';
    await sleep((reply.retryAfterSec ?? 1) * 1000 + Math.random() * 500); // 429, 503 or a failed request
  }
  return 'refused';
}
