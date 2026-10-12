// People's colours (6d spec §4): the eight fixed ones first, then generated ones for larger rooms.
import { PEER_COLORS } from '@zoom3d/shared';

/** Successive hues this far apart never bunch up, however many are taken. */
const GOLDEN_ANGLE = 137.508;
const SATURATION = 0.75;
const LIGHTNESS = 0.55;

function hslHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** The first fixed colour nobody present has, else the first unused generated one. */
export function pickColor(used: ReadonlySet<string>): string {
  const fixed = PEER_COLORS.find((c) => !used.has(c));
  if (fixed) {
    return fixed;
  }
  for (let i = 0; ; i++) {
    const c = hslHex((i * GOLDEN_ANGLE) % 360, SATURATION, LIGHTNESS);
    if (!used.has(c)) {
      return c;
    }
  }
}
