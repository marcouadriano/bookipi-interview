export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBackoff(startMs = 200, maxMs = 5000) {
  let delayMs = startMs;
  return {
    get delayMs() {
      return delayMs;
    },
    reset() {
      delayMs = startMs;
    },
    // Returns the current delay and doubles it for next time.
    advance() {
      const used = delayMs;
      delayMs = Math.min(delayMs * 2, maxMs);
      return used;
    },
    async wait() {
      await sleep(this.advance());
    },
  };
}
