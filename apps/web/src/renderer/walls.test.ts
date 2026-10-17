import { castRay, createRayHit, LEVEL1, parseMap } from '@zoom3d/shared';
import { describe, expect, test, vi } from 'vitest';
import { createView, setView } from './camera';
import { createFramebuffer, DEFAULT_FOV, scaleRgb } from './framebuffer';
import { GLOW_RADIUS, GLOW_STRENGTH, type Glow } from './glow';
import { bakeLighting, corridorLights, REFLECTION_RANGE, SIDE_SHADE } from './lighting';
import { firstDifference } from './test-helpers';
import { makeTextures, TEX } from './textures';
import { CEILING, FLOOR, renderWalls } from './walls';

/** Opaque black: what the reflections-only view shows where nothing reflects. */
const BLACK = 0xff000000;
const ROOM = parseMap('11111\n1...1\n1.S.1\n1...1\n11111');
const PROJ = 320 / Math.tan(DEFAULT_FOV / 2);
const textures = makeTextures(1);

function column(fb: ReturnType<typeof createFramebuffer>, x: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < fb.height; y++) {
    out.push(fb.pixels[y * fb.width + x] as number);
  }
  return out;
}

function textureColumn(tile: number, texX: number): number[] {
  const tex = textures[tile] as Uint32Array;
  return Array.from({ length: TEX }, (_, y) => tex[y * TEX + texX] as number);
}

describe('renderWalls', () => {
  const fb = createFramebuffer();
  renderWalls(fb, { map: ROOM, eye: { x: 2.5, y: 2.5, angle: 0 }, textures, lighting: null });

  test('framebuffer is 640x360 with a per-column z-buffer', () => {
    expect([fb.width, fb.height, fb.zbuffer.length]).toEqual([640, 360, 640]);
  });

  test('centre column distance is the perpendicular wall distance', () => {
    expect(fb.zbuffer[320]).toBeCloseTo(1.5);
  });

  test('centre column wall height is PROJ / distance', () => {
    const wall = column(fb, 320).filter((c) => c !== CEILING && c !== FLOOR).length;
    expect(Math.abs(wall - PROJ / 1.5)).toBeLessThanOrEqual(2);
  });

  test('ceiling above and floor below the walls', () => {
    expect(fb.pixels[0]).toBe(CEILING);
    expect(fb.pixels[fb.pixels.length - 1]).toBe(FLOOR);
  });

  test('every pixel is opaque', () => {
    expect(fb.pixels.every((c) => c >>> 24 === 0xff)).toBe(true);
  });

  test('far walls draw their top row, unlit and lit, from any pose', () => {
    // A wall under a texture's height on screen steps over a texel per row, so its top row can start over a texel
    // above the texture: under 64 px it was left transparent, under 32 px drawn black. Lit, nothing here is black.
    const row = '1'.repeat(25);
    const hall = parseMap([row, `1S${'.'.repeat(22)}1`, ...Array(2).fill(`1${'.'.repeat(23)}1`), row].join('\n'));
    const lit = bakeLighting(hall, [{ x: 12.5, y: 2.5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 }], 0.45, FLOOR, CEILING);
    const frame = createFramebuffer();
    const holes: string[] = [];
    for (const [x, y] of [
      [1.5, 1.3],
      [2.5, 2.5],
      [4.2, 3.7],
    ] as const) {
      for (let k = 0; k < 24; k++) {
        const pose = { x, y, angle: (k / 24) * Math.PI * 2 };
        for (const lighting of [null, lit]) {
          renderWalls(frame, { map: hall, eye: pose, textures, lighting, reflections: 'both' });
          const hole = frame.pixels.findIndex((c) => c >>> 24 !== 0xff || (lighting !== null && c === BLACK));
          if (hole >= 0) {
            holes.push(
              `${lighting ? 'lit' : 'unlit'} at ${x},${y},${k}/24: pixel ${hole % 640},${Math.floor(hole / 640)}`
            );
          }
        }
      }
    }
    expect(holes).toEqual([]);
  });

  test('x-side walls use unshaded texels (column mirrored when facing +x)', () => {
    const allowed = new Set(textureColumn(1, TEX - 32 - 1));
    const wall = column(fb, 320).filter((c) => c !== CEILING && c !== FLOOR);
    expect(wall.every((c) => allowed.has(c))).toBe(true);
  });

  test('y-side walls are shaded', () => {
    const south = createFramebuffer();
    renderWalls(south, { map: ROOM, eye: { x: 2.5, y: 2.5, angle: Math.PI / 2 }, textures, lighting: null });
    const allowed = new Set(textureColumn(1, 32).map((c) => scaleRgb(c, SIDE_SHADE)));
    const wall = column(south, 320).filter((c) => c !== CEILING && c !== FLOOR);
    expect(wall.length).toBeGreaterThan(300);
    expect(wall.every((c) => allowed.has(c))).toBe(true);
  });
});

describe('makeTextures', () => {
  test('is deterministic', () => {
    expect(makeTextures(1)).toEqual(makeTextures(1));
  });

  test('has three distinct 64x64 opaque wall textures', () => {
    expect(textures.slice(1).map((t) => t.length)).toEqual([TEX * TEX, TEX * TEX, TEX * TEX]);
    expect(textures[1]).not.toEqual(textures[2]);
    expect(textures[2]).not.toEqual(textures[3]);
    expect(textures.slice(1).every((t) => t.every((c) => c >>> 24 === 0xff))).toBe(true);
  });
});

test('a narrower FOV draws the same wall taller', () => {
  const player = { x: 2.5, y: 2.5, angle: 0 };
  const wide = createFramebuffer(296, 640, (66 * Math.PI) / 180);
  const narrow = createFramebuffer(296, 640, (50 * Math.PI) / 180);
  renderWalls(wide, { map: ROOM, eye: player, textures, lighting: null });
  renderWalls(narrow, { map: ROOM, eye: player, textures, lighting: null });
  const wallHeight = (fb: ReturnType<typeof createFramebuffer>) =>
    column(fb, 148).filter((c) => c !== CEILING && c !== FLOOR).length;
  expect(wallHeight(narrow)).toBeGreaterThan(wallHeight(wide));
  expect(wallHeight(narrow) / wallHeight(wide)).toBeCloseTo(
    Math.tan((33 * Math.PI) / 180) / Math.tan((25 * Math.PI) / 180),
    1
  );
});

test('lit, a frame of a new size and FOV draws as if it were the first', async () => {
  // The lit renderer keeps per-frame-size scratch buffers: a landscape frame before must not leave them stale.
  const level = parseMap(LEVEL1);
  const lit = bakeLighting(level, corridorLights(level), 0.45, FLOOR, CEILING);
  const pose = { x: 35.26, y: 27.38, angle: 4.48 };
  const portrait = () => createFramebuffer(296, 640, (50 * Math.PI) / 180);
  renderWalls(createFramebuffer(), { map: level, eye: pose, textures, lighting: lit });
  const after = portrait();
  renderWalls(after, { map: level, eye: pose, textures, lighting: lit });
  vi.resetModules();
  const fresh = await import('./walls');
  const first = portrait();
  fresh.renderWalls(first, { map: level, eye: pose, textures, lighting: lit });
  expect(firstDifference(after.pixels, first.pixels)).toBe(-1);
});

describe('renderWalls reflections', () => {
  // A corridor with a lamp near its east end.
  const corridor = parseMap('11111111111111\n1S...........1\n11111111111111');
  const lit = bakeLighting(
    corridor,
    [{ x: 10.5, y: 1.5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 }],
    0.45,
    FLOOR,
    CEILING
  );
  const matte = { ...lit, wallLamp: new Int8Array(lit.wallLamp.length).fill(-1) };
  const render = (x: number, lighting: typeof lit) => {
    const fb = createFramebuffer();
    renderWalls(fb, { map: corridor, eye: { x, y: 1.5, angle: 0 }, textures, lighting });
    return fb;
  };
  const channels = (c: number) => [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff];

  test('brightens a near wall seen along it towards a lamp, never darkens', () => {
    const shiny = render(7.5, lit).pixels;
    const plain = render(7.5, matte).pixels;
    let brighter = 0;
    for (let i = 0; i < plain.length; i++) {
      const a = channels(shiny[i] as number);
      const b = channels(plain[i] as number);
      expect(a.every((v, k) => v >= (b[k] as number))).toBe(true);
      if (a.some((v, k) => v > (b[k] as number))) {
        brighter++;
      }
    }
    expect(brighter).toBeGreaterThan(0);
  });

  test('leaves walls past REFLECTION_RANGE alone', () => {
    // Looking down the corridor: the end wall is far, the side walls near the edges are close.
    const shiny = render(1.5, lit);
    const plain = render(1.5, matte);
    let far = 0;
    for (let col = 0; col < plain.width; col++) {
      if ((plain.zbuffer[col] as number) < REFLECTION_RANGE) {
        continue;
      }
      far++;
      const differs = column(shiny, col).some((c, y) => c !== plain.pixels[y * plain.width + col]);
      expect(differs).toBe(false);
    }
    expect(far).toBeGreaterThan(0);
  });

  test('a wall you are not close to stays matte, even in range: the end of a corridor seen from down it', () => {
    // A wood end wall at x = 13, a lamp 1.5 in front of it; the eye 7 away, looking straight at it.
    const room = parseMap('33333333333332\n3S...........2\n3............2\n3............2\n33333333333332');
    const roomLit = bakeLighting(
      room,
      [{ x: 11.5, y: 2.5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 }],
      0.45,
      FLOOR,
      CEILING
    );
    const roomMatte = { ...roomLit, wallLamp: new Int8Array(roomLit.wallLamp.length).fill(-1) };
    const pose = { x: 6, y: 2.5, angle: 0 };
    const shiny = createFramebuffer();
    const plain = createFramebuffer();
    renderWalls(shiny, { map: room, eye: pose, textures, lighting: roomLit });
    renderWalls(plain, { map: room, eye: pose, textures, lighting: roomMatte });
    const centre = plain.width / 2;
    expect(plain.zbuffer[centre] as number).toBeLessThan(REFLECTION_RANGE);
    expect(column(shiny, centre)).toEqual(column(plain, centre));
  });

  test('a far wall face lying in line with the eye stays matte: no stripe down its edge', () => {
    // On LEVEL1, looking north up the wood corridor from x 35.26: wall side faces 5–6.5 tiles ahead lie almost in
    // line with the eye, so their planes pass close to it, but the faces themselves are far off.
    const level = parseMap(LEVEL1);
    const levelLit = bakeLighting(level, corridorLights(level), 0.45, FLOOR, CEILING);
    const levelMatte = { ...levelLit, wallLamp: new Int8Array(levelLit.wallLamp.length).fill(-1) };
    const pose = { x: 35.26, y: 27.38, angle: 4.48 };
    const shiny = createFramebuffer();
    const plain = createFramebuffer();
    renderWalls(shiny, { map: level, eye: pose, textures, lighting: levelLit });
    renderWalls(plain, { map: level, eye: pose, textures, lighting: levelMatte });
    for (let col = 0; col < plain.width; col++) {
      if ((plain.zbuffer[col] as number) > 5) {
        expect(column(shiny, col)).toEqual(column(plain, col));
      }
    }
  });

  test('the wall you hug still streaks far ahead along it', () => {
    const hall = parseMap('1111111111111\n1S..........1\n1...........1\n1...........1\n1111111111111');
    const hallLit = bakeLighting(
      hall,
      [{ x: 9.5, y: 2.5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 }],
      0.45,
      FLOOR,
      CEILING
    );
    const hallMatte = { ...hallLit, wallLamp: new Int8Array(hallLit.wallLamp.length).fill(-1) };
    // Close to the top wall at its west end, looking east along it.
    const pose = { x: 1.5, y: 1.3, angle: 0.05 };
    const shiny = createFramebuffer();
    const plain = createFramebuffer();
    renderWalls(shiny, { map: hall, eye: pose, textures, lighting: hallLit, reflections: 'walls' });
    renderWalls(plain, { map: hall, eye: pose, textures, lighting: hallMatte, reflections: 'walls' });
    let farShine = 0;
    for (let col = 0; col < plain.width; col++) {
      const far = (plain.zbuffer[col] as number) > 4;
      if (far && column(shiny, col).some((c, y) => c !== plain.pixels[y * plain.width + col])) {
        farShine++;
      }
    }
    expect(farShine).toBeGreaterThan(0);
  });

  test('a wall barely shines seen face-on, but streaks seen along it towards a lamp', () => {
    const room = parseMap('3333333333\n3S.......3\n3........3\n3........3\n3333333333');
    const roomLit = bakeLighting(
      room,
      [{ x: 6.5, y: 2.5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 }],
      0.45,
      FLOOR,
      CEILING
    );
    const roomMatte = { ...roomLit, wallLamp: new Int8Array(roomLit.wallLamp.length).fill(-1) };
    const brightest = (pose: { x: number; y: number; angle: number }) => {
      const a = createFramebuffer();
      const b = createFramebuffer();
      renderWalls(a, { map: room, eye: pose, textures, lighting: roomLit });
      renderWalls(b, { map: room, eye: pose, textures, lighting: roomMatte });
      let most = 0;
      for (let i = 0; i < a.pixels.length; i++) {
        most = Math.max(most, ((a.pixels[i] as number) >>> 16) - ((b.pixels[i] as number) >>> 16));
      }
      return most;
    };
    // Under the lamp, facing the top wall; then close to that wall, looking east along it towards the lamp.
    const faceOn = brightest({ x: 6.5, y: 2.5, angle: -Math.PI / 2 });
    const along = brightest({ x: 2.5, y: 1.3, angle: 0 });
    expect(along).toBeGreaterThan(faceOn * 3);
  });

  test('on a blue wall, the reflection is a brighter blue: mostly blue, red never ahead of green', () => {
    const blue = parseMap('3333333333\n3S.......3\n3333333333');
    const blueLit = bakeLighting(
      blue,
      [{ x: 6.5, y: 1.5, z: 0.85, radius: 4.5, r: 1.25, g: 1.05, b: 0.75 }],
      0.45,
      FLOOR,
      CEILING
    );
    const shiny = createFramebuffer();
    const plain = createFramebuffer();
    // Close to the top wall, looking along it towards the lamp.
    const pose = { x: 2.5, y: 1.2, angle: -0.1 };
    renderWalls(shiny, { map: blue, eye: pose, textures, lighting: blueLit });
    renderWalls(plain, {
      map: blue,
      eye: pose,
      textures,
      lighting: {
        ...blueLit,
        wallLamp: new Int8Array(blueLit.wallLamp.length).fill(-1),
      },
    });
    let redAdded = 0;
    let greenAdded = 0;
    let blueAdded = 0;
    for (let i = 0; i < plain.pixels.length; i++) {
      const [r, g, b] = channels(shiny.pixels[i] as number) as [number, number, number];
      const [r0, g0, b0] = channels(plain.pixels[i] as number) as [number, number, number];
      redAdded += r - r0;
      greenAdded += g - g0;
      blueAdded += b - b0;
      // Rounding can tip one channel by one step.
      expect(r - r0).toBeLessThanOrEqual(g - g0 + 1);
    }
    expect(redAdded).toBeGreaterThan(0);
    // Mostly blue, not washed white: red and green gain little next to it.
    expect(blueAdded).toBeGreaterThan(2.5 * greenAdded);
  });
});

describe('renderWalls floor reflections', () => {
  // A 3-wide corridor, a lamp near its east end; the eye at its west end, looking along it.
  const hall = parseMap('1111111111111\n1S..........1\n1...........1\n1...........1\n1111111111111');
  const hallLit = bakeLighting(
    hall,
    [{ x: 7.5, y: 2.5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 }],
    0.45,
    FLOOR,
    CEILING
  );
  const hallMatte = {
    ...hallLit,
    wallLamp: new Int8Array(hallLit.wallLamp.length).fill(-1),
    floorLamp: new Int8Array(hallLit.floorLamp.length).fill(-1),
  };
  const pose = { x: 2.5, y: 2.5, angle: 0 };
  const channels = (c: number) => [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff];
  const shiny = createFramebuffer();
  const plain = createFramebuffer();
  renderWalls(shiny, { map: hall, eye: pose, textures, lighting: hallLit });
  renderWalls(plain, { map: hall, eye: pose, textures, lighting: hallMatte });

  test('the floor shines between the eye and the lamp, and never darkens', () => {
    let brighter = 0;
    for (let y = plain.height / 2; y < plain.height; y++) {
      for (let x = 0; x < plain.width; x++) {
        const i = y * plain.width + x;
        const a = channels(shiny.pixels[i] as number);
        const b = channels(plain.pixels[i] as number);
        expect(a.every((v, k) => v >= (b[k] as number))).toBe(true);
        if (a.some((v, k) => v > (b[k] as number))) {
          brighter++;
        }
      }
    }
    expect(brighter).toBeGreaterThan(100);
  });
});

describe('renderWalls reflection modes', () => {
  // The hall from the floor tests: the eye at its west end looks along it at a lamp near its east end.
  const hall = parseMap('1111111111111\n1S..........1\n1...........1\n1...........1\n1111111111111');
  const hallLit = bakeLighting(
    hall,
    [{ x: 7.5, y: 2.5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 }],
    0.45,
    FLOOR,
    CEILING
  );
  const hallMatte = {
    ...hallLit,
    wallLamp: new Int8Array(hallLit.wallLamp.length).fill(-1),
    floorLamp: new Int8Array(hallLit.floorLamp.length).fill(-1),
  };
  // Close to the top wall, so the wall shines too.
  const pose = { x: 2.5, y: 1.3, angle: 0 };
  const render = (mode: 'none' | 'walls' | 'both' | 'only' | 'matte') => {
    const fb = createFramebuffer();
    renderWalls(fb, {
      map: hall,
      eye: pose,
      textures,
      lighting: mode === 'matte' ? hallMatte : hallLit,
      reflections: mode === 'matte' ? 'none' : mode,
    });
    return fb;
  };
  /** How many pixels differ from the matte render, above and below the horizon. */
  const changed = (fb: ReturnType<typeof render>) => {
    const matte = render('matte');
    let wall = 0;
    let floor = 0;
    for (let i = 0; i < fb.pixels.length; i++) {
      if (fb.pixels[i] !== matte.pixels[i]) {
        if (isWallPixel(matte, i)) {
          wall++;
        } else {
          floor++;
        }
      }
    }
    return { wall, floor };
  };
  /** A wall pixel: between its column's wall top and bottom, worked out from the wall height. */
  const isWallPixel = (fb: ReturnType<typeof render>, i: number) => {
    const col = i % fb.width;
    const y = Math.floor(i / fb.width);
    const lineH = PROJ / (fb.zbuffer[col] as number);
    return Math.abs(y - fb.height / 2) < lineH / 2;
  };

  test('none draws no reflections at all', () => {
    expect(changed(render('none'))).toEqual({ wall: 0, floor: 0 });
  });

  test('walls reflects on the walls only', () => {
    const { wall, floor } = changed(render('walls'));
    expect(wall).toBeGreaterThan(0);
    expect(floor).toBe(0);
  });

  test('both reflects on the walls and the floor', () => {
    const { wall, floor } = changed(render('both'));
    expect(wall).toBeGreaterThan(0);
    expect(floor).toBeGreaterThan(0);
  });

  test('only draws the reflections alone: black where none shows, never brighter than with the light', () => {
    const only = render('only');
    const both = render('both');
    const matte = render('matte');
    let wall = 0;
    let floor = 0;
    let wrong = 0;
    for (let i = 0; i < only.pixels.length; i++) {
      const c = only.pixels[i] as number;
      const lit = both.pixels[i] as number;
      if (lit === matte.pixels[i]) {
        wrong += c === BLACK ? 0 : 1;
        continue;
      }
      for (const shift of [0, 8, 16]) {
        wrong += ((c >>> shift) & 0xff) > ((lit >>> shift) & 0xff) ? 1 : 0;
      }
      wrong += c === BLACK ? 1 : 0;
      if (isWallPixel(matte, i)) {
        wall++;
      } else {
        floor++;
      }
    }
    expect(wrong).toBe(0);
    expect(wall).toBeGreaterThan(0);
    expect(floor).toBeGreaterThan(0);
  });
});

describe('renderWalls floor reflections in shadow', () => {
  // One lamp beyond a pillar: the pillar shades the floor behind it from the lamp. Its light reaches the whole hall,
  // so floor with only ambient light is in its shadow, not just out of reach.
  const hall = parseMap('1111111111111\n1...........1\n1S.....1....1\n1...........1\n1111111111111');
  const hallLit = bakeLighting(hall, [{ x: 9.5, y: 2.5, z: 0.85, radius: 20, r: 1, g: 1, b: 1 }], 0.45, FLOOR, CEILING);
  const hallMatte = {
    ...hallLit,
    wallLamp: new Int8Array(hallLit.wallLamp.length).fill(-1),
    floorLamp: new Int8Array(hallLit.floorLamp.length).fill(-1),
  };
  // The floor where no lamp reaches: ambient light only.
  const shadow = hallLit.floor[0] as number;

  test('no floor pixel in the lamp’s shadow ever shines', () => {
    let shaded = 0;
    for (const pose of [
      { x: 2.5, y: 1.5, angle: 0.2 },
      { x: 2.5, y: 3.5, angle: -0.2 },
      { x: 4.5, y: 2.5, angle: 0.4 },
      { x: 4.5, y: 2.5, angle: -0.4 },
    ]) {
      const shiny = createFramebuffer();
      const plain = createFramebuffer();
      renderWalls(shiny, { map: hall, eye: pose, textures, lighting: hallLit });
      renderWalls(plain, { map: hall, eye: pose, textures, lighting: hallMatte });
      for (let i = (plain.height / 2) * plain.width; i < plain.pixels.length; i++) {
        const y = Math.floor(i / plain.width);
        const floorDistance = (0.5 * PROJ) / (y + 0.5 - plain.height / 2);
        // Floor only: a wall pixel can match the shadow's colour by chance.
        if (plain.pixels[i] === shadow && floorDistance < (plain.zbuffer[i % plain.width] as number)) {
          shaded++;
          if (shiny.pixels[i] !== shadow) {
            throw new Error(`a shaded floor pixel shines at ${pose.x},${pose.y},${pose.angle}, pixel ${i}`);
          }
        }
      }
    }
    expect(shaded).toBeGreaterThan(100);
  });
});

describe('renderWalls avatar glow', () => {
  const room = parseMap('1111111111\n1S.......1\n1........1\n1........1\n1111111111');
  const roomLit = bakeLighting(room, [], 0.08, FLOOR, CEILING);
  // Looking east along the room's middle, an avatar 3 tiles ahead glowing white.
  const pose = { x: 1.5, y: 2.5, angle: 0 };
  const glow = { x: 4.5, y: 2.5, r: GLOW_STRENGTH, g: GLOW_STRENGTH, b: GLOW_STRENGTH };
  const render = (glows: { x: number; y: number; r: number; g: number; b: number }[]) => {
    const fb = createFramebuffer();
    renderWalls(fb, { map: room, eye: pose, textures, lighting: roomLit, reflections: 'both' }, glows);
    return fb;
  };
  const dark = render([]);
  const lit = render([glow]);
  /** The floor distance a screen row below the horizon shows. */
  const rowDistance = (y: number) => (0.5 * PROJ) / (y + 0.5 - dark.height / 2);

  test('the floor around the avatar glows, and nothing ever darkens', () => {
    let brighter = 0;
    for (let i = 0; i < dark.pixels.length; i++) {
      const a = (lit.pixels[i] as number) & 0xff;
      const b = (dark.pixels[i] as number) & 0xff;
      expect(a).toBeGreaterThanOrEqual(b);
      if (a > b) {
        brighter++;
      }
    }
    expect(brighter).toBeGreaterThan(100);
  });

  test('floor rows past the glow’s reach are untouched', () => {
    const centre = dark.width / 2;
    for (let y = dark.height / 2 + 1; y < dark.height; y++) {
      const d = rowDistance(y);
      // Straight ahead, the floor 1.5 tiles or more from the avatar (3 tiles off) is out of its reach.
      if (d < 3 - GLOW_RADIUS || d > 3 + GLOW_RADIUS) {
        expect(lit.pixels[y * dark.width + centre]).toBe(dark.pixels[y * dark.width + centre]);
      }
    }
  });

  test('glows add up with each other: two avatars side by side light the dark floor more than one', () => {
    const one = render([glow]);
    const two = render([glow, { ...glow, y: 2.6 }]);
    let more = 0;
    for (let i = (dark.height / 2) * dark.width; i < dark.pixels.length; i++) {
      if (((two.pixels[i] as number) & 0xff) > ((one.pixels[i] as number) & 0xff)) {
        more++;
      }
    }
    expect(more).toBeGreaterThan(100);
  });

  test('it doesn’t add to a brighter light: under a strong lamp, an avatar changes nothing around it', () => {
    // A lamp over the room lights everything more than the glow does, so the glow is lost in it, as a screen is.
    const bright = bakeLighting(
      room,
      [{ x: 4.5, y: 2.5, z: 0.85, radius: 20, r: 3, g: 3, b: 3 }],
      0.08,
      FLOOR,
      CEILING
    );
    const without = createFramebuffer();
    const withGlow = createFramebuffer();
    renderWalls(without, { map: room, eye: pose, textures, lighting: bright, reflections: 'none' }, []);
    renderWalls(withGlow, { map: room, eye: pose, textures, lighting: bright, reflections: 'none' }, [glow]);
    let changed = 0;
    for (let i = 0; i < without.pixels.length; i++) {
      if (withGlow.pixels[i] !== without.pixels[i]) {
        changed++;
      }
    }
    expect(changed).toBe(0);
  });

  test('the reflections-only view leaves the glow out: with no lamps it is black', () => {
    const fb = createFramebuffer();
    renderWalls(fb, { map: room, eye: pose, textures, lighting: roomLit, reflections: 'only' }, [glow]);
    expect(fb.pixels.every((c) => c === BLACK)).toBe(true);
  });

  test('the ceiling over the avatar glows too', () => {
    let brighter = 0;
    for (let i = 0; i < (dark.height / 2) * dark.width; i++) {
      if (((lit.pixels[i] as number) & 0xff) > ((dark.pixels[i] as number) & 0xff)) {
        brighter++;
      }
    }
    expect(brighter).toBeGreaterThan(100);
  });
});

describe('renderWalls wall reflections in a doorway’s shadow', () => {
  // A wood room lit only by a lamp in its south doorway. Past the lamp's reach, the east wall reflects it, and the
  // door's east jamb shades it: the line from the lamp past the jamb's corner meets the wall at y = 3, a tile corner.
  // The lamp is a disc, so that shadow is soft, about 4 tiles wide that far from the door.
  const room = parseMap(
    [
      '2222222222222',
      '2S..........2',
      ...Array(6).fill('2...........2'),
      '222222.222222',
      '2...........2',
      '2222222222222',
    ].join('\n')
  );
  const lm = bakeLighting(room, [{ x: 6.5, y: 8.5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 }], 0.08, FLOOR, CEILING);
  /** The biggest step in red between neighbouring pixels of a row, anywhere in the reflections-only view. */
  const biggestStep = (pose: { x: number; y: number; angle: number }) => {
    const fb = createFramebuffer();
    renderWalls(fb, { map: room, eye: pose, textures, lighting: lm, reflections: 'only' });
    let biggest = 0;
    for (let y = 0; y < fb.height; y++) {
      for (let x = 1; x < fb.width; x++) {
        const step =
          ((fb.pixels[y * fb.width + x] as number) & 0xff) - ((fb.pixels[y * fb.width + x - 1] as number) & 0xff);
        biggest = Math.max(biggest, Math.abs(step));
      }
    }
    return biggest;
  };

  test('a wall that sees only part of the lamp reflects only that part', () => {
    const fullySeen = { ...lm, wallLampSeen: new Uint8Array(lm.wallLampSeen.length).fill(255) };
    /** The red summed over the reflections-only view. */
    const total = (lighting: typeof lm) => {
      const fb = createFramebuffer();
      renderWalls(fb, { map: room, eye: { x: 10.5, y: 2.5, angle: 0 }, textures, lighting, reflections: 'only' });
      return fb.pixels.reduce((sum, c) => sum + (c & 0xff), 0);
    };
    // The east wall in view sees 60–90% of the lamp past the jamb, and under half of it beyond y = 3.
    expect(total(lm)).toBeLessThan(0.8 * total(fullySeen));
  });

  test('the reflection fades through the shadow instead of stopping at a tile edge', () => {
    expect(biggestStep({ x: 10.5, y: 2.5, angle: 0 })).toBeLessThanOrEqual(3);
    expect(biggestStep({ x: 11.25, y: 2.75, angle: 0 })).toBeLessThanOrEqual(3);
  });
});

describe('renderWalls wall reflections of two lamps', () => {
  // A 3-wide wood corridor with two lamps down its middle, the eye at its south end looking up its east wall (LEVEL1's
  // corridor south of the lower wood room). Along that wall the far lamp's reflection gives way to the near one's.
  const hall = parseMap(['22222', '2S..2', ...Array(20).fill('2...2'), '22222'].join('\n'));
  const lamp = { z: 0.85, radius: 4.5, r: 1.25, g: 1.05, b: 0.75 };
  const lm = bakeLighting(
    hall,
    [
      { ...lamp, x: 2.5, y: 13.5 },
      { ...lamp, x: 2.5, y: 18.5 },
    ],
    0.08,
    FLOOR,
    CEILING
  );

  test('the reflection changes smoothly where one lamp takes over from the other', () => {
    const pose = { x: 2.26, y: 21.06, angle: 5.45 };
    const fb = createFramebuffer();
    renderWalls(fb, { map: hall, eye: pose, textures, lighting: lm, reflections: 'only' });
    // The columns showing the east wall (its west face), and in each the rows well inside the wall.
    const view = setView(createView(), fb, pose);
    const hit = createRayHit();
    const eastWall = Array.from({ length: fb.width }, (_, col) => {
      const rayX = view.dirX + view.planeX * ((2 * col) / fb.width - 1);
      const rayY = view.dirY + view.planeY * ((2 * col) / fb.width - 1);
      castRay(hall, pose.x, pose.y, rayX, rayY, hit);
      return hit.side === 0 && rayX > 0;
    });
    let biggest = 0;
    for (let col = 1; col < fb.width; col++) {
      if (!eastWall[col] || !eastWall[col - 1]) {
        continue;
      }
      const half = view.proj / (fb.zbuffer[col] as number) / 2;
      for (let y = Math.ceil(fb.height / 2 - half) + 2; y < fb.height / 2 + half - 2; y++) {
        const step =
          ((fb.pixels[y * fb.width + col] as number) & 0xff) - ((fb.pixels[y * fb.width + col - 1] as number) & 0xff);
        biggest = Math.max(biggest, Math.abs(step));
      }
    }
    expect(biggest).toBeLessThanOrEqual(2);
  });
});

describe('renderWalls ceiling reflections', () => {
  // A 3-wide hall, a lamp near its east end; the eye at its west end, looking along it.
  const hall = parseMap('1111111111111\n1S..........1\n1...........1\n1...........1\n1111111111111');
  const hallLit = bakeLighting(
    hall,
    [{ x: 7.5, y: 2.5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 }],
    0.45,
    FLOOR,
    CEILING
  );
  const dark = bakeLighting(hall, [], 0.08, FLOOR, CEILING);
  const pose = { x: 2.5, y: 2.5, angle: 0 };
  const render = (lm: typeof hallLit, mode: 'walls' | 'both', glows: Glow[] = []) => {
    const fb = createFramebuffer();
    renderWalls(fb, { map: hall, eye: pose, textures, lighting: lm, reflections: mode }, glows);
    return fb;
  };
  /** Ceiling pixels brighter with ceiling reflections than without, and the red they gain; fails on any darker. */
  const brighterCeiling = (lm: typeof hallLit, glows: Glow[] = []) => {
    const a = render(lm, 'both', glows);
    const b = render(lm, 'walls', glows);
    let brighter = 0;
    let added = 0;
    // The upper half: walls look the same in both modes, so any change is the ceiling.
    for (let i = 0; i < (b.height / 2) * b.width; i++) {
      const lit = (a.pixels[i] as number) & 0xff;
      const plain = (b.pixels[i] as number) & 0xff;
      expect(lit).toBeGreaterThanOrEqual(plain);
      added += lit - plain;
      if (lit > plain) {
        brighter++;
      }
    }
    return { brighter, added, a, b };
  };

  test('the ceiling mirrors the lamp’s reflection on the floor, and never darkens', () => {
    expect(brighterCeiling(hallLit).brighter).toBeGreaterThan(100);
  });

  test('it mirrors only the floor’s reflections, not the floor: with no lamp, not even a glowing one shows', () => {
    const glow = { x: 5.5, y: 2.5, r: GLOW_STRENGTH, g: GLOW_STRENGTH, b: GLOW_STRENGTH };
    expect(brighterCeiling(dark).brighter).toBe(0);
    expect(brighterCeiling(dark, [glow]).brighter).toBe(0);
  });

  test('it shows the lamp’s light off the floor, not a mirror of the floor: no cut-off at the far wall’s mirror image', () => {
    const { a, b } = brighterCeiling(hallLit);
    const centre = b.width / 2;
    let beyond = 0;
    for (let y = 0; y < b.height / 2; y++) {
      // A mirror ceiling would show the floor at 3d and stop where that passes the end wall; this light doesn't.
      const d = (0.5 * PROJ) / (b.height / 2 - y - 0.5);
      if (3 * d > (b.zbuffer[centre] as number) + 0.5 && d < (b.zbuffer[centre] as number)) {
        beyond +=
          ((a.pixels[y * b.width + centre] as number) & 0xff) - ((b.pixels[y * b.width + centre] as number) & 0xff);
      }
    }
    expect(beyond).toBeGreaterThan(0);
  });
});
