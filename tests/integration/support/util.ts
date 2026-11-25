import { sleep } from '@flashsale/shared/node';

export { sleep };

// Polls until `check` returns true. Throws with `label`
// on timeout, so a failure says what never happened.
export async function until(
  label: string,
  check: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`);
}
