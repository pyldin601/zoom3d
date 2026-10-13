// Randomness helpers shared by the simulations (server and landing page). The caller passes the generator, so tests
// can seed it.

/** A random element of `items`, or undefined when there are none. */
export const pick = <T>(rng: () => number, items: readonly T[]): T | undefined =>
  items.at(Math.floor(rng() * items.length));

/** Deterministic but varied randomness: the same seed gives the same sequence (tests, the landing show). */
export function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}
