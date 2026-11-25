// What the page and the Sale Service agree on: poll intervals, the processing time limit and the
// user ID rule. The stress test behaves like the page, so it reads the timings too.
export const SALE_POLL_MS = 3000;
export const QUEUE_POLL_MS = 3000;
export const PURCHASE_POLL_MS = 1000;
export const PURCHASE_PROCESSING_LIMIT_MS = 30_000;

const USER_ID_PATTERN = /^[a-z0-9._@+-]{1,64}$/;

// Trim and lowercase, then validate. Returns null when the ID is invalid
export function normalizeUserId(raw: string): string | null {
  const id = raw.trim().toLowerCase();
  return USER_ID_PATTERN.test(id) ? id : null;
}
