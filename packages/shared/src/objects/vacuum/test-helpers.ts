// Shared by the robot vacuum's tests.

export { seeded } from '../../random';

/** The value, or a thrown error naming what was missing. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected a ${what}`);
  }
  return value;
}
