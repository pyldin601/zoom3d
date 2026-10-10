// The "zoom3d" title of the landing picture: blocky pixel letters drawn into the framebuffer itself, so they sit
// on the scene's pixel grid. Chrome fading into red, a black outline and a drop shadow, like an old title screen.
import { type Framebuffer, rgb } from '../renderer/framebuffer';

export const LOGO_TEXT = 'zoom3d';
/** Framebuffer pixels per glyph cell. */
export const LOGO_CELL = 6;
/** Glyph height in cells; shorter glyphs (the x-height letters) sit on the baseline. */
export const LOGO_ROWS = 8;
const GAP = 1;
/** Outline width and drop-shadow offset, in framebuffer pixels. */
export const LOGO_OUTLINE = 3;
export const LOGO_SHADOW = 4;

export const LOGO_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  z: ['######', '######', '..###.', '.###..', '######', '######'],
  o: ['.####.', '######', '##..##', '##..##', '######', '.####.'],
  m: ['#########.', '##########', '##..##..##', '##..##..##', '##..##..##', '##..##..##'],
  '3': ['#####.', '######', '....##', '..###.', '..####', '....##', '######', '#####.'],
  d: ['....##', '....##', '.#####', '######', '##..##', '##..##', '######', '.#####'],
};

/** Logo width in cells, gaps included. */
export const LOGO_WIDTH =
  [...LOGO_TEXT].reduce((w, ch) => w + (LOGO_GLYPHS[ch]?.[0]?.length ?? 0), 0) + GAP * (LOGO_TEXT.length - 1);

const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/** Fill colour of the logo's pixel row `y` (0 = top of the tallest glyph). */
export function logoColour(y: number): number {
  const height = LOGO_ROWS * LOGO_CELL;
  const split = height / 2;
  if (y < split) {
    const t = y / (split - 1);
    return rgb(mix(250, 140, t), mix(250, 140, t), mix(255, 160, t));
  }
  const t = (y - split) / (height - split - 1);
  return rgb(mix(240, 110, t), mix(70, 12, t), mix(60, 12, t));
}

/**
 * Draws the logo `margin` pixels from the top of `fb`: in the top-right corner, `margin` from the right, or centred
 * (a portrait phone frame, mobile spec §3).
 */
export function drawLogo(fb: Framebuffer, margin: number, align: 'right' | 'center' = 'right'): void {
  const pad = LOGO_OUTLINE + LOGO_SHADOW;
  const w = LOGO_WIDTH * LOGO_CELL + 2 * pad;
  const h = LOGO_ROWS * LOGO_CELL + 2 * pad;
  const letters = LOGO_WIDTH * LOGO_CELL;
  const left = (align === 'center' ? Math.round((fb.width - letters) / 2) : fb.width - margin - letters) - pad;
  const top = margin - pad;
  // Which pixels of the padded box the letters cover.
  const ink = new Uint8Array(w * h);
  let cellX = 0;
  for (const ch of LOGO_TEXT) {
    const rows = LOGO_GLYPHS[ch] as readonly string[];
    const dropped = LOGO_ROWS - rows.length;
    rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== '#') {
          continue;
        }
        for (let dy = 0; dy < LOGO_CELL; dy++) {
          for (let dx = 0; dx < LOGO_CELL; dx++) {
            ink[(pad + (dropped + r) * LOGO_CELL + dy) * w + pad + (cellX + c) * LOGO_CELL + dx] = 1;
          }
        }
      }
    });
    cellX += (rows[0] as string).length + GAP;
  }
  const inked = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && ink[y * w + x] === 1;
  const near = (x: number, y: number, r: number) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (inked(x + dx, y + dy)) {
          return true;
        }
      }
    }
    return false;
  };
  const black = rgb(0, 0, 0);
  const shadow = rgb(16, 16, 20);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = left + x;
      const fy = top + y;
      if (fx < 0 || fy < 0 || fx >= fb.width || fy >= fb.height) {
        continue;
      }
      let c: number | null = null;
      if (inked(x, y)) {
        c = logoColour(y - pad);
      } else if (near(x, y, LOGO_OUTLINE)) {
        c = black;
      } else if (near(x - LOGO_SHADOW, y - LOGO_SHADOW, LOGO_OUTLINE)) {
        c = shadow;
      }
      if (c !== null) {
        fb.pixels[fy * fb.width + fx] = c;
      }
    }
  }
}
