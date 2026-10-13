// Shared by the server's robot vacuum tests (the sim's own tests live with it in packages/shared).

/** The value, or a thrown error naming what was missing. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected a ${what}`);
  }
  return value;
}
