export const PORTAL_PULSE_HZ = 0.8;
export const PORTAL_PULSE_DEPTH = 0.4;

/** Linear colour of every portal's glow. */
export const PORTAL_PINK: { readonly r: number; readonly g: number; readonly b: number } = { r: 1, g: 0.42, b: 0.78 };

/** Swells between `1 − PORTAL_PULSE_DEPTH` and 1, starting at the midpoint; each player runs it on their own clock. */
export function portalPulse(seconds: number): number {
  return 1 - PORTAL_PULSE_DEPTH * (0.5 - 0.5 * Math.sin(2 * Math.PI * PORTAL_PULSE_HZ * seconds));
}
