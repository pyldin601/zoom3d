import { expect, test } from 'vitest';
import { createFramebuffer, rgb } from '../renderer/framebuffer';
import {
  drawLogo,
  LOGO_CELL,
  LOGO_GLYPHS,
  LOGO_OUTLINE,
  LOGO_ROWS,
  LOGO_TEXT,
  LOGO_WIDTH,
  logoColour,
} from './landing-logo';

const SKY = rgb(1, 2, 3);

function blank() {
  const fb = createFramebuffer();
  fb.pixels.fill(SKY);
  return fb;
}

test('every glyph is a rectangle of # and . no taller than the logo', () => {
  for (const ch of LOGO_TEXT) {
    const rows = LOGO_GLYPHS[ch] as readonly string[];
    expect(rows.length, ch).toBeLessThanOrEqual(LOGO_ROWS);
    for (const row of rows) {
      expect(row, ch).toMatch(/^[#.]+$/);
      expect(row.length, ch).toBe((rows[0] as string).length);
    }
  }
});

test('the logo sits in the top-right corner, `margin` pixels from the top and from the right', () => {
  const fb = blank();
  drawLogo(fb, 20);
  let minX = fb.width;
  let minY = fb.height;
  for (let y = 0; y < fb.height; y++) {
    for (let x = 0; x < fb.width; x++) {
      if (fb.pixels[y * fb.width + x] !== SKY) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
      }
    }
  }
  // The outline reaches LOGO_OUTLINE past the letters on the left and top; the shadow only falls right and down.
  const lettersRight = minX + LOGO_OUTLINE + LOGO_WIDTH * LOGO_CELL;
  expect(fb.width - lettersRight).toBe(20);
  expect(minY + LOGO_OUTLINE).toBe(20);
});

test('letters are filled with the gradient, edged in black', () => {
  const fb = blank();
  drawLogo(fb, 20);
  // The `d` is the last glyph; its top-right cell is filled (`....##`).
  const x = fb.width - 20 - 2;
  expect(fb.pixels[(20 + 1) * fb.width + x]).toBe(logoColour(1));
  expect(fb.pixels[(20 - 1) * fb.width + x]).toBe(rgb(0, 0, 0));
});

test('the gradient runs from chrome at the top to red at the bottom', () => {
  const top = logoColour(0);
  const bottom = logoColour(LOGO_ROWS * LOGO_CELL - 1);
  const red = (c: number) => c & 0xff;
  const blue = (c: number) => (c >>> 16) & 0xff;
  expect(blue(top)).toBeGreaterThan(200);
  expect(red(bottom)).toBeGreaterThan(blue(bottom) * 3);
});

test('a centred logo fits a 296 px frame with equal side margins, `margin` from the top', () => {
  const fb = createFramebuffer(296, 640);
  fb.pixels.fill(SKY);
  drawLogo(fb, 28, 'center');
  let minX = fb.width;
  let maxX = -1;
  let minY = fb.height;
  for (let y = 0; y < fb.height; y++) {
    for (let x = 0; x < fb.width; x++) {
      if (fb.pixels[y * fb.width + x] !== SKY) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
      }
    }
  }
  // Letters span LOGO_WIDTH cells; the outline adds LOGO_OUTLINE on the left, outline + shadow on the right.
  const lettersLeft = minX + LOGO_OUTLINE;
  const lettersRight = lettersLeft + LOGO_WIDTH * LOGO_CELL;
  expect(lettersLeft).toBeGreaterThan(0);
  expect(Math.abs(lettersLeft - (fb.width - lettersRight))).toBeLessThanOrEqual(1);
  expect(maxX).toBeLessThan(fb.width);
  expect(minY + LOGO_OUTLINE).toBe(28);
});
