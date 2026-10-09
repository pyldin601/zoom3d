// Token bucket: `burst` tokens, refilled at `ratePerSec`.
export function createTokenBucket(ratePerSec: number, burst: number, now: () => number): { take(): boolean } {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSec);
      last = t;
      if (tokens < 1) {
        return false;
      }
      tokens -= 1;
      return true;
    },
  };
}
