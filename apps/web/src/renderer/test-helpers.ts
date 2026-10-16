// Test helpers for the renderer and the scenes drawn with it.

/**
 * The first pixel where two frames differ, or −1 when they're the same (a length mismatch differs at the shorter's
 * end). Compare frames with this, not toEqual: vitest's deep equality takes ~150 ms on a 640×360 frame locally and
 * over 1 s on CI, against about a millisecond here.
 */
export function firstDifference(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) {
    return Math.min(a.length, b.length);
  }
  return a.findIndex((c, i) => c !== b.at(i));
}
