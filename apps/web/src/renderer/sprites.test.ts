import { type PlayerState, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createFramebuffer, rgb } from './framebuffer';
import { AVATAR_RADIUS, hexToRgb, type Projection, projectSprite, renderSprites } from './sprites';
import { makeTextures } from './textures';
import { FOV, renderWalls, shade } from './walls';

const OPEN = parseMap(
  [
    '111111111',
    '1.......1',
    '1.......1',
    '1.......1',
    '1S......1',
    '1.......1',
    '1.......1',
    '1.......1',
    '111111111',
  ].join('\n'),
);
const PROJ = 320 / Math.tan(FOV / 2);
const textures = makeTextures(1);
const player: PlayerState = { x: 1.5, y: 4.5, angle: 0 };
const RED = rgb(255, 0, 0);
const BLUE = rgb(0, 0, 255);

function frame(map = OPEN) {
  const fb = createFramebuffer();
  renderWalls(fb, map, player, textures);
  return fb;
}
const px = (fb: ReturnType<typeof frame>, x: number, y: number) => fb.pixels[y * fb.width + x];

describe('renderSprites', () => {
  test('a sprite straight ahead is drawn centred with diameter 2R·PROJ/depth', () => {
    const fb = frame();
    renderSprites(fb, player, [{ x: 3.5, y: 4.5, color: RED }]);
    expect(px(fb, 320, 180)).toBe(RED);
    let width = 0;
    for (let x = 0; x < fb.width; x++) {
      const c = px(fb, x, 180);
      if (c === RED || c === shade(RED)) width++;
    }
    expect(Math.abs(width - (2 * AVATAR_RADIUS * PROJ) / 2)).toBeLessThanOrEqual(2);
  });

  test('the outer ring is shaded', () => {
    const fb = frame();
    renderSprites(fb, player, [{ x: 3.5, y: 4.5, color: RED }]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    expect(px(fb, Math.floor(320 + 0.92 * r), 180)).toBe(shade(RED));
  });

  test('a sprite behind the camera draws nothing', () => {
    const fb = frame();
    const before = fb.pixels.slice();
    renderSprites(fb, player, [{ x: 0.5, y: 4.5, color: RED }]);
    expect(fb.pixels).toEqual(before);
  });

  test('walls in front hide the sprite', () => {
    const walled = parseMap(
      [
        '111111111',
        '1.......1',
        '1.......1',
        '1.......1',
        '1S.1....1',
        '1.......1',
        '1.......1',
        '1.......1',
        '111111111',
      ].join('\n'),
    );
    const fb = frame(walled);
    const wallPixel = px(fb, 320, 180);
    renderSprites(fb, player, [{ x: 5.5, y: 4.5, color: RED }]);
    expect(px(fb, 320, 180)).toBe(wallPixel);
  });

  test('the nearer of two overlapping sprites wins regardless of input order', () => {
    const fb = frame();
    renderSprites(fb, player, [
      { x: 3.5, y: 4.5, color: RED },
      { x: 5.5, y: 4.5, color: BLUE },
    ]);
    expect(px(fb, 320, 180)).toBe(RED);
  });
});

describe('projectSprite', () => {
  test('a sprite to the north while facing east is left of centre', () => {
    const out: Projection = { screenX: 0, depth: 0, size: 0 };
    expect(projectSprite(player, 3.5, 3.5, 640, out)).toBe(true);
    expect(out.screenX).toBeLessThan(320);
    expect(out.depth).toBeCloseTo(2);
  });

  test('reports sprites behind the camera as not visible', () => {
    expect(projectSprite(player, 0.5, 4.5, 640, { screenX: 0, depth: 0, size: 0 })).toBe(false);
  });
});

test('hexToRgb packs like rgb()', () => {
  expect(hexToRgb('#e6194b')).toBe(rgb(0xe6, 0x19, 0x4b));
});
