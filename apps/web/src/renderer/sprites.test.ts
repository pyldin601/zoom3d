import { type PlayerState, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { FACE_SIZE } from '../media/faces';
import { MOUTH_Y_IN_CROP } from '../media/framing';
import { BOOMBOX_LEFT, BOOMBOX_SPRITE, BOOMBOX_TOP } from './boombox';
import { createFramebuffer, rgb } from './framebuffer';
import {
  CHEERS_LEFT,
  CHEERS_TOP,
  CHEERS_WOBBLE,
  FACE_MOUTH_Y,
  HELD_LEFT,
  HELD_LIPS,
  HELD_SPRITES,
  HELD_TEXEL,
  HELD_TOP,
  sipLeft,
  sipTop,
} from './held-items';
import {
  AVATAR_RADIUS,
  BOB_HEIGHT,
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
    renderSprites(fb, player, [
      {
        x: 3.5,
        y: 4.5,
        color: RED,
        face: null,
        speaking: 0,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
    ]);
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
    renderSprites(fb, player, [
      {
        x: 3.5,
        y: 4.5,
        color: RED,
        face: null,
        speaking: 0,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
    ]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    expect(px(fb, Math.floor(320 + 0.92 * r), 180)).toBe(shade(RED));
  });

  test('a sprite behind the camera draws nothing', () => {
    const fb = frame();
    const before = fb.pixels.slice();
    renderSprites(fb, player, [
      {
        x: 0.5,
        y: 4.5,
        color: RED,
        face: null,
        speaking: 0,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
    ]);
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
    renderSprites(fb, player, [
      {
        x: 5.5,
        y: 4.5,
        color: RED,
        face: null,
        speaking: 0,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
    ]);
    expect(px(fb, 320, 180)).toBe(wallPixel);
  });

  test('the nearer of two overlapping sprites wins regardless of input order', () => {
    const fb = frame();
    renderSprites(fb, player, [
      {
        x: 3.5,
        y: 4.5,
        color: RED,
        face: null,
        speaking: 0,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
      {
        x: 5.5,
        y: 4.5,
        color: BLUE,
        face: null,
        speaking: 0,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
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
    renderSprites(fb, player, [
      {
        x: 3.5,
        y: 4.5,
        color: RED,
        face,
        speaking: 0,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
    ]);
    const c = px(fb, 320, 180) as number;
    expect(Math.abs(texelI(c) - FACE_SIZE / 2)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(texelJ(c) - FACE_SIZE / 2)).toBeLessThanOrEqual(tolerance);
  });

  test('the outer ring is the peer colour, unshaded', () => {
    const fb = frame();
    renderSprites(fb, player, [
      {
        x: 3.5,
        y: 4.5,
        color: RED,
        face,
        speaking: 0,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
    ]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    expect(px(fb, Math.floor(320 + 0.92 * r), 180)).toBe(RED);
  });

  test('the face is not mirrored: left of centre samples a smaller column', () => {
    const fb = frame();
    renderSprites(fb, player, [
      {
        x: 3.5,
        y: 4.5,
        color: RED,
        face,
        speaking: 0,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
    ]);
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
    renderSprites(quiet, player, [
      {
        x: 3.5,
        y: 4.5,
        color: RED,
        face,
        speaking: 0,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
    ]);
    expect(px(quiet, Math.floor(320 + 0.92 * r), 180)).toBe(RED);
    const loud = frame();
    renderSprites(loud, player, [
      {
        x: 3.5,
        y: 4.5,
        color: RED,
        face,
        speaking: 1,
        bob: 0,
        itemBob: 0,
        sip: 0,
        cheers: 0,
        wobble: 0,
        held: null,
        boombox: false,
      },
    ]);
    expect(px(loud, Math.floor(320 + 0.92 * r), 180)).toBe(mixWhite(RED, 0.8));
  });
});

describe('floor shadows', () => {
  const red = (c: number | undefined) => (c ?? 0) & 0xff;
  /** Floor row under a point `depth` tiles straight ahead (camera at half wall height). */
  const floorRow = (depth: number) => Math.floor(180 + (0.5 * PROJ) / depth);
  const sprite = (x: number, y = 4.5, color = RED) => ({
    x,
    y,
    color,
    face: null,
    speaking: 0,
    bob: 0,
    itemBob: 0,
    sip: 0,
    cheers: 0,
    wobble: 0,
    held: null,
    boombox: false,
  });

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
  const beer = (x: number, y = 4.5) => ({
    x,
    y,
    color: RED,
    face: null,
    speaking: 0,
    bob: 0,
    itemBob: 0,
    sip: 0,
    cheers: 0,
    wobble: 0,
    held: 'beer' as const,
    boombox: false,
  });
  // Screen pixel of item texel (u, v) for a sprite straight ahead at `depth`.
  const itemPx = (u: number, v: number, depth: number) => {
    const r = (AVATAR_RADIUS * PROJ) / depth;
    const t = HELD_TEXEL * r;
    return [Math.floor(320 + HELD_LEFT * r + (u + 0.5) * t), Math.floor(180 - HELD_TOP * r + (v + 0.5) * t)] as const;
  };
  const tex = (u: number, v: number) => HELD_SPRITES.beer.texels[v * HELD_SPRITES.beer.w + u];
  // Glass, beer and fist.
  const SAMPLES = [
    [0, 9],
    [4, 5],
    [7, 5],
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
    renderSprites(fb, player, [{ ...beer(3.5), held: null, boombox: false }]);
    expect(px(fb, ...itemPx(7, 5, 2))).toBe(px(empty, ...itemPx(7, 5, 2)));
  });

  test('walls in front hide the item too', () => {
    const fb = frame(WALLED);
    const before = fb.pixels.slice();
    renderSprites(fb, player, [beer(5.5)]);
    expect(fb.pixels).toEqual(before);
  });

  test("a cheers raises the drink over the disc's upper right", () => {
    const fb = frame();
    renderSprites(fb, player, [{ ...beer(3.5), cheers: 1 }]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    const t = HELD_TEXEL * r;
    const x = Math.floor(320 + CHEERS_LEFT * r + 0.5 * t);
    const y = Math.floor(180 - CHEERS_TOP * r + 9.5 * t);
    expect(px(fb, x, y)).toBe(tex(0, 9));
  });

  test('the wobble moves the raised drink sideways', () => {
    const fb = frame();
    renderSprites(fb, player, [{ ...beer(3.5), cheers: 1, wobble: 1 }]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    const t = HELD_TEXEL * r;
    const x = Math.floor(320 + (CHEERS_LEFT + CHEERS_WOBBLE) * r + 0.5 * t);
    const y = Math.floor(180 - CHEERS_TOP * r + 9.5 * t);
    expect(px(fb, x, y)).toBe(tex(0, 9));
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

  test('a bobbing avatar is drawn higher by BOB_HEIGHT radii; its shadow stays on the floor', () => {
    const topRow = (fb: ReturnType<typeof frame>) => {
      for (let y = 0; y < fb.height; y++) {
        const c = px(fb, 320, y);
        if (c === RED || c === shade(RED)) {
          return y;
        }
      }
      return -1;
    };
    const still = frame();
    renderSprites(still, player, [{ ...beer(3.5), held: null, boombox: false }]);
    const up = frame();
    renderSprites(up, player, [{ ...beer(3.5), held: null, bob: 1 }]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    expect(Math.abs(topRow(still) - topRow(up) - BOB_HEIGHT * r)).toBeLessThanOrEqual(1);
    const floor = Math.floor(180 + (0.5 * PROJ) / 2);
    for (let x = 0; x < still.width; x++) {
      expect(px(up, x, floor)).toBe(px(still, x, floor));
    }
  });

  test('the drink lifts by itemBob, on its own', () => {
    const fb = frame();
    renderSprites(fb, player, [{ ...beer(3.5), itemBob: 1 }]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    const t = HELD_TEXEL * r;
    const lifted = (u: number, v: number) =>
      [
        Math.floor(320 + HELD_LEFT * r + (u + 0.5) * t),
        Math.floor(180 - HELD_TOP * r - BOB_HEIGHT * r + (v + 0.5) * t),
      ] as const;
    expect(px(fb, ...lifted(0, 9))).toBe(tex(0, 9));
    expect(px(fb, ...lifted(4, 5))).toBe(tex(4, 5));
  });

  test("at full sip each drink's lip point is on the framed face's mouth", () => {
    // The framed 256² face spans the disc's inner circle (1.7 r across); framing puts the mouth at MOUTH_Y_IN_CROP.
    expect(FACE_MOUTH_Y).toBeCloseTo((MOUTH_Y_IN_CROP - 0.5) * 1.7, 9);
    expect(HELD_LIPS).toEqual({ beer: [3.5, 2.5], coffee: [3.5, 2], wine: [4, 0.5] });
    for (const item of ['beer', 'coffee', 'wine'] as const) {
      const [u, v] = HELD_LIPS[item];
      expect(sipLeft(item) + u * HELD_TEXEL).toBeCloseTo(0, 9);
      expect(-sipTop(item) + v * HELD_TEXEL).toBeCloseTo(FACE_MOUTH_Y, 9);
    }
  });

  test("at full sip the beer's foam is on the mouth, and no drink puts the fist there", () => {
    const r = (AVATAR_RADIUS * PROJ) / 2;
    const mouth = [320, Math.floor(180 + FACE_MOUTH_Y * r)] as const;
    const hand = ['#f2c29b', '#c98d6a', '#8a5236'].map(hexToRgb);
    for (const item of ['beer', 'coffee', 'wine'] as const) {
      const fb = frame();
      renderSprites(fb, player, [{ ...beer(3.5), held: item, sip: 1 }]);
      expect(hand).not.toContain(px(fb, ...mouth));
      if (item === 'beer') {
        expect(px(fb, ...mouth)).toBe(tex(3, 2));
      }
    }
  });

  test('half a sip is halfway', () => {
    const fb = frame();
    renderSprites(fb, player, [{ ...beer(3.5), sip: 0.5 }]);
    const r = (AVATAR_RADIUS * PROJ) / 2;
    const t = HELD_TEXEL * r;
    const left = (HELD_LEFT + sipLeft('beer')) / 2;
    const top = (HELD_TOP + sipTop('beer')) / 2;
    expect(px(fb, Math.floor(320 + left * r + 4.5 * t), Math.floor(180 - top * r + 5.5 * t))).toBe(tex(4, 5));
  });

  test('a very near item crossing the right edge does not wrap into the next row', () => {
    const plain = frame();
    renderSprites(plain, player, [{ ...beer(2.0, 4.48), held: null, boombox: false }]);
    const fb = frame();
    renderSprites(fb, player, [beer(2.0, 4.48)]);
    for (let y = 0; y < fb.height; y++) {
      expect(px(fb, 0, y)).toBe(px(plain, 0, y));
    }
  });
});

describe('held item shadows', () => {
  const floorRow = (depth: number) => Math.floor(180 + (0.5 * PROJ) / depth);
  const holding = (held: 'beer' | 'wine' | null) => ({
    x: 3.5,
    y: 4.5,
    color: RED,
    face: null,
    speaking: 0,
    bob: 0,
    itemBob: 0,
    sip: 0,
    cheers: 0,
    wobble: 0,
    held,
    boombox: false,
  });
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

  test('at full sip the item casts no extra shadow (it would double the disc shadow)', () => {
    const row = floorRow(2);
    const sipping = frame();
    renderSprites(sipping, player, [{ ...holding('beer'), sip: 1 }]);
    expect(changed(sipping, render(null), row)).toBe(0);
  });

  test('raised in a cheers, the item casts no extra shadow', () => {
    const row = floorRow(2);
    const raised = frame();
    renderSprites(raised, player, [{ ...holding('beer'), cheers: 1 }]);
    expect(changed(raised, render(null), row)).toBe(0);
  });

  test("the item's shadow follows the drink towards the mouth", () => {
    const row = floorRow(2);
    const none = render(null);
    const rightmost = (sip: number) => {
      const fb = frame();
      renderSprites(fb, player, [{ ...holding('beer'), sip }]);
      let last = -1;
      for (let x = 0; x < fb.width; x++) {
        if (px(fb, x, row) !== px(none, x, row)) {
          last = x;
        }
      }
      return last;
    };
    expect(rightmost(0.5)).toBeGreaterThan(0);
    expect(rightmost(0.5)).toBeLessThan(rightmost(0));
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
    // The beer's own shadow, sized from its width, reaches past the avatar's on the right.
    const beer = render('beer');
    expect(shaded(beer, 320, 640) - shaded(beer, 0, 320)).toBeGreaterThan(1);
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

describe('boombox', () => {
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
  const carrier = (x: number) => ({
    x,
    y: 4.5,
    color: RED,
    face: null,
    speaking: 0,
    bob: 0,
    itemBob: 0,
    sip: 0,
    cheers: 0,
    wobble: 0,
    held: null,
    boombox: true,
  });
  /** Screen pixel of boombox texel (u, v) for a sprite straight ahead at `depth`. */
  const boxPx = (u: number, v: number, depth: number, lift = 0) => {
    const r = (AVATAR_RADIUS * PROJ) / depth;
    const t = HELD_TEXEL * r;
    return [
      Math.floor(320 + BOOMBOX_LEFT * r + (u + 0.5) * t),
      Math.floor(180 - (BOOMBOX_TOP + lift * BOB_HEIGHT) * r + (v + 0.5) * t),
    ] as const;
  };
  const tex = (u: number, v: number) => BOOMBOX_SPRITE.texels[v * BOOMBOX_SPRITE.w + u];
  const SAMPLES = [
    [7, 1],
    [2, 8],
    [7, 8],
  ] as const;

  test("a boombox is drawn to the viewer's left of the disc, scaled with distance", () => {
    for (const depth of [2, 4]) {
      const fb = frame();
      renderSprites(fb, player, [carrier(1.5 + depth)]);
      for (const [u, v] of SAMPLES) {
        expect(px(fb, ...boxPx(u, v, depth))).toBe(tex(u, v));
      }
    }
  });

  test('boombox false draws none of it', () => {
    const fb = frame();
    renderSprites(fb, player, [{ ...carrier(3.5), boombox: false }]);
    // Skin and the cassette label: colours neither the disc nor the room has.
    for (const [u, v] of [
      [7, 1],
      [7, 7],
      [8, 8],
    ] as const) {
      expect(px(fb, ...boxPx(u, v, 2))).not.toBe(tex(u, v));
    }
  });

  test('walls in front hide it', () => {
    const fb = frame(WALLED);
    const before = fb.pixels.slice();
    renderSprites(fb, player, [carrier(5.5)]);
    expect(fb.pixels).toEqual(before);
  });

  test('it casts a floor shadow on the left, clear of the disc shadow', () => {
    const red = (c: number | undefined) => (c ?? 0) & 0xff;
    // 0.45 tiles left of the avatar: inside the boombox shadow, outside the disc's (0.3).
    const x = Math.floor(320 - (0.45 * PROJ) / 2);
    const row = Math.floor(180 + (0.5 * PROJ) / 2);
    const without = frame();
    renderSprites(without, player, [{ ...carrier(3.5), boombox: false }]);
    const fb = frame();
    renderSprites(fb, player, [carrier(3.5)]);
    expect(red(px(fb, x, row))).toBeLessThan(red(px(without, x, row)));
  });

  test('it lifts by itemBob', () => {
    const fb = frame();
    renderSprites(fb, player, [{ ...carrier(3.5), itemBob: 1 }]);
    expect(px(fb, ...boxPx(7, 8, 2, 1))).toBe(tex(7, 8));
  });

  test('a sip moves only the drink', () => {
    const still = frame();
    renderSprites(still, player, [{ ...carrier(3.5), held: 'beer' as const }]);
    const sipping = frame();
    renderSprites(sipping, player, [{ ...carrier(3.5), held: 'beer' as const, sip: 1 }]);
    for (const [u, v] of SAMPLES) {
      expect(px(sipping, ...boxPx(u, v, 2))).toBe(px(still, ...boxPx(u, v, 2)));
    }
  });
});
