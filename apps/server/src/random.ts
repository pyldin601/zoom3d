// Randomness helpers shared by the server's simulations. The caller passes the generator, so tests can seed it.

/** A random element of `items`, or undefined when there are none. */
export const pick = <T>(rng: () => number, items: readonly T[]): T | undefined =>
  items.at(Math.floor(rng() * items.length));
