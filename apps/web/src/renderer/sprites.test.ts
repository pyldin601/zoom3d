import { type PlayerState, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { FACE_SIZE } from '../media/faces';
import { createFramebuffer, rgb } from './framebuffer';
import { HELD_LEFT, HELD_SPRITES, HELD_TEXEL, HELD_TOP } from './held-items';
import {
  AVATAR_RADIUS,
  hexToRgb,
  mixWhite,
  type Projection,
  projectSprite,
  renderSprites,
  SHADOW_LEVELS,
  SHADOW_RADIUS,
} from './sprites';
import { makeTextures } from './textures';
import { FLOOR, FOV, renderWalls, shade } from './walls';

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
  ].join('\n')
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
    renderSprites(fb, player, [{ x: 3.5, y: 4.5, color: RED, face: null, speaking: 0, held: null }]);
    expect(px(fb, 320, 180)).toBe(RED);
    let width = 0;
    for (let x = 0; x < fb.width; x++) {
      const c = px(fb, x, 180);
      if (c === RED || c === shade(RED)) {
        width++;
      }
    }
    expect(Math.abs(width - (2 * AVATAR_RADIUS * PROJ) / 2)).toBeLessThanOrEqual(2);
  });

  test('the outer ring is shaded', () => {
    const fb = frame();
    renderSprites(fb, player, [{ x: 3.5, y: 4.5, color: RED, face: null, speaking: 0, held: null }]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    expect(px(fb, Math.floor(320 + 0.92 * r), 180)).toBe(shade(RED));
  });

  test('a sprite behind the camera draws nothing', () => {
    const fb = frame();
    const before = fb.pixels.slice();
    renderSprites(fb, player, [{ x: 0.5, y: 4.5, color: RED, face: null, speaking: 0, held: null }]);
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
      ].join('\n')
    );
    const fb = frame(walled);
    const wallPixel = px(fb, 320, 180);
    renderSprites(fb, player, [{ x: 5.5, y: 4.5, color: RED, face: null, speaking: 0, held: null }]);
    expect(px(fb, 320, 180)).toBe(wallPixel);
  });

  test('the nearer of two overlapping sprites wins regardless of input order', () => {
    const fb = frame();
    renderSprites(fb, player, [
      { x: 3.5, y: 4.5, color: RED, face: null, speaking: 0, held: null },
      { x: 5.5, y: 4.5, color: BLUE, face: null, speaking: 0, held: null },
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

describe('face sprites', () => {
  const face = new Uint32Array(FACE_SIZE * FACE_SIZE);
  for (let j = 0; j < FACE_SIZE; j++) {
    for (let i = 0; i < FACE_SIZE; i++) {
      face[j * FACE_SIZE + i] = rgb((i * 256) / FACE_SIZE, (j * 256) / FACE_SIZE, 0);
    }
  }
  // Texel column/row encoded in the red/green channels, independent of FACE_SIZE.
  const texelI = (c: number) => ((c & 0xff) * FACE_SIZE) / 256;
  const texelJ = (c: number) => (((c >> 8) & 0xff) * FACE_SIZE) / 256;
  const tolerance = FACE_SIZE / 128 + 1;

  test('the disc centre shows the centre of the face texture', () => {
    const fb = frame();
    renderSprites(fb, player, [{ x: 3.5, y: 4.5, color: RED, face, speaking: 0, held: null }]);
    const c = px(fb, 320, 180) as number;
    expect(Math.abs(texelI(c) - FACE_SIZE / 2)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(texelJ(c) - FACE_SIZE / 2)).toBeLessThanOrEqual(tolerance);
  });

  test('the outer ring is the peer colour, unshaded', () => {
    const fb = frame();
    renderSprites(fb, player, [{ x: 3.5, y: 4.5, color: RED, face, speaking: 0, held: null }]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    expect(px(fb, Math.floor(320 + 0.92 * r), 180)).toBe(RED);
  });

  test('the face is not mirrored: left of centre samples a smaller column', () => {
    const fb = frame();
    renderSprites(fb, player, [{ x: 3.5, y: 4.5, color: RED, face, speaking: 0, held: null }]);
    expect(texelI(px(fb, 290, 180) as number)).toBeLessThan(texelI(px(fb, 350, 180) as number));
  });
});

describe('speaking ring', () => {
  test('mixWhite blends toward white and keeps alpha', () => {
    expect(mixWhite(rgb(0, 0, 0), 0)).toBe(rgb(0, 0, 0));
    expect(mixWhite(rgb(0, 0, 0), 1)).toBe(rgb(255, 255, 255));
    expect(mixWhite(rgb(200, 0, 100), 0.5)).toBe(rgb(227, 127, 177));
  });

  test('a speaking avatar lights its ring; a silent one keeps its colour', () => {
    const face = new Uint32Array(FACE_SIZE * FACE_SIZE).fill(rgb(1, 2, 3));
    const r = (AVATAR_RADIUS * PROJ) / 2;
    const quiet = frame();
    renderSprites(quiet, player, [{ x: 3.5, y: 4.5, color: RED, face, speaking: 0, held: null }]);
    expect(px(quiet, Math.floor(320 + 0.92 * r), 180)).toBe(RED);
    const loud = frame();
    renderSprites(loud, player, [{ x: 3.5, y: 4.5, color: RED, face, speaking: 1, held: null }]);
    expect(px(loud, Math.floor(320 + 0.92 * r), 180)).toBe(mixWhite(RED, 0.8));
  });
});

describe('floor shadows', () => {
  const red = (c: number | undefined) => (c ?? 0) & 0xff;
  /** Floor row under a point `depth` tiles straight ahead (camera at half wall height). */
  const floorRow = (depth: number) => Math.floor(180 + (0.5 * PROJ) / depth);
  const sprite = (x: number, y = 4.5, color = RED) => ({ x, y, color, face: null, speaking: 0, held: null });

  test('the floor right under an avatar is darkened, most at the centre', () => {
    const fb = frame();
    renderSprites(fb, player, [sprite(3.5)]);
    const centre = px(fb, 320, floorRow(2));
    const nearEdge = px(fb, 320, floorRow(2 - SHADOW_RADIUS * 0.8));
    expect(red(centre)).toBe(Math.floor(red(FLOOR) * (1 - 0.33)));
    expect(red(nearEdge)).toBeGreaterThan(red(centre));
    expect(red(nearEdge)).toBeLessThan(red(FLOOR));
  });

  test('the shadow is pixelated: a few flat bands, blocky in world space', () => {
    const fb = frame();
    const before = fb.pixels.slice();
    renderSprites(fb, player, [sprite(3.5)]);
    const shades = new Set<number>();
    fb.pixels.forEach((c, i) => {
      if (before[i] === FLOOR && c !== FLOOR && c !== RED && c !== shade(RED)) {
        shades.add(c);
      }
    });
    expect(shades.size).toBeGreaterThan(1);
    expect(shades.size).toBeLessThanOrEqual(SHADOW_LEVELS);
    // Near the centre a world texel spans several screen pixels: neighbours share a colour.
    const row = floorRow(2);
    let same = 0;
    for (let x = 300; x < 340; x++) {
      if (px(fb, x, row) === px(fb, x + 1, row)) {
        same++;
      }
    }
    expect(same).toBeGreaterThan(30);
  });

  test('there is a gap of floor between the floating disc and its shadow', () => {
    const fb = frame();
    renderSprites(fb, player, [sprite(3.5)]);
    const discBottom = Math.ceil(180 + (AVATAR_RADIUS * PROJ) / 2);
    const shadowTop = floorRow(2 + SHADOW_RADIUS);
    expect(shadowTop).toBeGreaterThan(discBottom + 2);
    expect(px(fb, 320, discBottom + 1)).toBe(FLOOR);
  });

  test('only floor under the shadow changes: walls, ceiling and other floor are untouched', () => {
    const fb = frame();
    const before = fb.pixels.slice();
    renderSprites(fb, player, [sprite(3.5)]);
    for (let i = 0; i < before.length; i++) {
      if (fb.pixels[i] === before[i]) {
        continue;
      }
      const row = Math.floor(i / fb.width);
      const isDisc = fb.pixels[i] === RED || fb.pixels[i] === shade(RED);
      expect(isDisc || (before[i] === FLOOR && row >= floorRow(2 + SHADOW_RADIUS) - 1)).toBe(true);
    }
    expect(px(fb, 100, 350)).toBe(FLOOR);
  });

  test('an avatar hidden behind a wall casts no visible shadow', () => {
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
      ].join('\n')
    );
    const fb = frame(walled);
    const before = fb.pixels.slice();
    renderSprites(fb, player, [sprite(5.5)]);
    expect(fb.pixels).toEqual(before);
  });

  test("a nearer disc covers a farther avatar's shadow", () => {
    const fb = frame();
    renderSprites(fb, player, [sprite(4.5, 4.5, BLUE), sprite(2.5)]);
    expect(px(fb, 320, floorRow(3))).toBe(RED);
  });
});

describe('held items', () => {
  const WALLED = parseMap(
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
    ].join('\n')
  );
  const beer = (x: number, y = 4.5) => ({ x, y, color: RED, face: null, speaking: 0, held: 'beer' as const });
  // Screen pixel of item texel (u, v) for a sprite straight ahead at `depth`.
  const itemPx = (u: number, v: number, depth: number) => {
    const r = (AVATAR_RADIUS * PROJ) / depth;
    const t = HELD_TEXEL * r;
    return [Math.floor(320 + HELD_LEFT * r + (u + 0.5) * t), Math.floor(180 - HELD_TOP * r + (v + 0.5) * t)] as const;
  };
  const tex = (u: number, v: number) => HELD_SPRITES.beer.texels[v * HELD_SPRITES.beer.w + u];
  const SAMPLES = [
    [12, 9],
    [8, 5],
    [2, 5],
  ] as const;

  test("a held beer is drawn to the viewer's right of the disc", () => {
    const fb = frame();
    renderSprites(fb, player, [beer(3.5)]);
    for (const [u, v] of SAMPLES) {
      expect(px(fb, ...itemPx(u, v, 2))).toBe(tex(u, v));
    }
  });

  test('the item scales with distance', () => {
    const fb = frame();
    renderSprites(fb, player, [beer(5.5)]);
    for (const [u, v] of SAMPLES) {
      expect(px(fb, ...itemPx(u, v, 4))).toBe(tex(u, v));
    }
  });

  test('held null draws nothing beyond the disc', () => {
    const empty = frame();
    const fb = frame();
    renderSprites(fb, player, [{ ...beer(3.5), held: null }]);
    expect(px(fb, ...itemPx(8, 5, 2))).toBe(px(empty, ...itemPx(8, 5, 2)));
  });

  test('walls in front hide the item too', () => {
    const fb = frame(WALLED);
    const before = fb.pixels.slice();
    renderSprites(fb, player, [beer(5.5)]);
    expect(fb.pixels).toEqual(before);
  });

  test("the held item covers the disc's lower right, in front of the body", () => {
    const fb = frame();
    renderSprites(fb, player, [beer(3.5)]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    // Inside the disc (0.71 r from its centre), so without the item this pixel is the disc.
    const [x, y] = [Math.floor(320 + 0.5 * r), Math.floor(180 + 0.5 * r)];
    const u = Math.floor((0.5 * r - HELD_LEFT * r) / (HELD_TEXEL * r));
    const v = Math.floor((0.5 * r + HELD_TOP * r) / (HELD_TEXEL * r));
    expect(px(fb, x, y)).toBe(tex(u, v));
    expect(tex(u, v)).not.toBe(0);
  });

  test('a very near item crossing the right edge does not wrap into the next row', () => {
    const plain = frame();
    renderSprites(plain, player, [{ ...beer(2.0, 4.48), held: null }]);
    const fb = frame();
    renderSprites(fb, player, [beer(2.0, 4.48)]);
    for (let y = 0; y < fb.height; y++) {
      expect(px(fb, 0, y)).toBe(px(plain, 0, y));
    }
  });
});

describe('held item shadows', () => {
  const floorRow = (depth: number) => Math.floor(180 + (0.5 * PROJ) / depth);
  const holding = (held: 'beer' | 'wine' | null) => ({ x: 3.5, y: 4.5, color: RED, face: null, speaking: 0, held });
  /** Screen column under the held item's centre for a sprite 2 tiles straight ahead. */
  const itemCol = (item: 'beer' | 'wine') => {
    const offset = (HELD_LEFT + (HELD_TEXEL * HELD_SPRITES[item].w) / 2) * AVATAR_RADIUS;
    return Math.floor(320 + (PROJ * offset) / 2);
  };
  const render = (held: 'beer' | 'wine' | null) => {
    const fb = frame();
    renderSprites(fb, player, [holding(held)]);
    return fb;
  };
  /** Pixels of row `row` that differ between two frames (the item's shadow may overlap the avatar's). */
  const changed = (a: ReturnType<typeof frame>, b: ReturnType<typeof frame>, row: number) => {
    let n = 0;
    for (let x = 0; x < a.width; x++) {
      if (px(a, x, row) !== px(b, x, row)) {
        n++;
      }
    }
    return n;
  };

  test('the floor under a held item is darkened', () => {
    const at = (fb: ReturnType<typeof frame>) => (px(fb, itemCol('beer'), floorRow(2)) as number) & 0xff;
    expect(at(render('beer'))).toBeLessThan(at(render(null)));
  });

  test('no item, no extra shadow: the shadow is symmetric under the avatar', () => {
    const shaded = (fb: ReturnType<typeof frame>, from: number, to: number) => {
      let n = 0;
      for (let x = from; x < to; x++) {
        if (px(fb, x, floorRow(2)) !== FLOOR) {
          n++;
        }
      }
      return n;
    };
    const none = render(null);
    expect(Math.abs(shaded(none, 320, 640) - shaded(none, 0, 320))).toBeLessThanOrEqual(1);
    const beer = render('beer');
    expect(shaded(beer, 320, 640) - shaded(beer, 0, 320)).toBeGreaterThan(5);
  });

  test("an item's shadow is smaller than the avatar's, and follows the item's width", () => {
    const row = floorRow(2);
    const none = render(null);
    const avatar = changed(none, frame(), row);
    const beerShadow = changed(render('beer'), none, row);
    const wineShadow = changed(render('wine'), none, row);
    expect(beerShadow).toBeGreaterThan(0);
    expect(beerShadow).toBeLessThan(avatar);
    expect(wineShadow).toBeGreaterThan(0);
    expect(wineShadow).toBeLessThan(beerShadow);
  });
});
