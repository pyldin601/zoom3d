// Shared by the robot vacuum's tests.

/** Deterministic but varied randomness, as in bots.test.ts. */
export function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** The value, or a thrown error naming what was missing. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected a ${what}`);
  }
  return value;
}
