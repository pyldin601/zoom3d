import { LEVEL1, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createFramebuffer, DEFAULT_FOV } from './framebuffer';
import { GLOW_RADIUS, GLOW_STRENGTH, type Glow } from './glow';
import { bakeLighting, corridorLights, REFLECTION_RANGE } from './lighting';
import { makeTextures, TEX } from './textures';
import { CEILING, FLOOR, renderWalls, shade } from './walls';

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
  renderWalls(fb, ROOM, { x: 2.5, y: 2.5, angle: 0 }, textures);

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

  test('x-side walls use unshaded texels (column mirrored when facing +x)', () => {
    const allowed = new Set(textureColumn(1, TEX - 32 - 1));
    const wall = column(fb, 320).filter((c) => c !== CEILING && c !== FLOOR);
    expect(wall.every((c) => allowed.has(c))).toBe(true);
  });

  test('y-side walls are shaded', () => {
    const south = createFramebuffer();
    renderWalls(south, ROOM, { x: 2.5, y: 2.5, angle: Math.PI / 2 }, textures);
    const allowed = new Set(textureColumn(1, 32).map(shade));
    const wall = column(south, 320).filter((c) => c !== CEILING && c !== FLOOR);
    expect(wall.length).toBeGreaterThan(300);
    expect(wall.every((c) => allowed.has(c))).toBe(true);
  });
});

describe('shade', () => {
  test('scales channels to 70% and keeps alpha', () => {
    expect(shade(0xff6464c8)).toBe(0xff4646_8c);
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
  renderWalls(wide, ROOM, player, textures);
  renderWalls(narrow, ROOM, player, textures);
  const wallHeight = (fb: ReturnType<typeof createFramebuffer>) =>
    column(fb, 148).filter((c) => c !== CEILING && c !== FLOOR).length;
  expect(wallHeight(narrow)).toBeGreaterThan(wallHeight(wide));
  expect(wallHeight(narrow) / wallHeight(wide)).toBeCloseTo(
    Math.tan((33 * Math.PI) / 180) / Math.tan((25 * Math.PI) / 180),
    1
  );
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
  const matte = { ...lit, wallLamp: new Int16Array(lit.wallLamp.length).fill(-1) };
  const render = (x: number, lighting: typeof lit) => {
    const fb = createFramebuffer();
    renderWalls(fb, corridor, { x, y: 1.5, angle: 0 }, textures, lighting);
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
    const roomMatte = { ...roomLit, wallLamp: new Int16Array(roomLit.wallLamp.length).fill(-1) };
    const pose = { x: 6, y: 2.5, angle: 0 };
    const shiny = createFramebuffer();
    const plain = createFramebuffer();
    renderWalls(shiny, room, pose, textures, roomLit);
    renderWalls(plain, room, pose, textures, roomMatte);
    const centre = plain.width / 2;
    expect(plain.zbuffer[centre] as number).toBeLessThan(REFLECTION_RANGE);
    expect(column(shiny, centre)).toEqual(column(plain, centre));
  });

  test('a far wall face lying in line with the eye stays matte: no stripe down its edge', () => {
    // On LEVEL1, looking north up the wood corridor from x 35.26: wall side faces 5–6.5 tiles ahead lie almost in
    // line with the eye, so their planes pass close to it, but the faces themselves are far off.
    const level = parseMap(LEVEL1);
    const levelLit = bakeLighting(level, corridorLights(level), 0.45, FLOOR, CEILING);
    const levelMatte = { ...levelLit, wallLamp: new Int16Array(levelLit.wallLamp.length).fill(-1) };
    const pose = { x: 35.26, y: 27.38, angle: 4.48 };
    const shiny = createFramebuffer();
    const plain = createFramebuffer();
    renderWalls(shiny, level, pose, textures, levelLit);
    renderWalls(plain, level, pose, textures, levelMatte);
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
    const hallMatte = { ...hallLit, wallLamp: new Int16Array(hallLit.wallLamp.length).fill(-1) };
    // Close to the top wall at its west end, looking east along it.
    const pose = { x: 1.5, y: 1.3, angle: 0.05 };
    const shiny = createFramebuffer();
    const plain = createFramebuffer();
    renderWalls(shiny, hall, pose, textures, hallLit, 'walls');
    renderWalls(plain, hall, pose, textures, hallMatte, 'walls');
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
    const roomMatte = { ...roomLit, wallLamp: new Int16Array(roomLit.wallLamp.length).fill(-1) };
    const brightest = (pose: { x: number; y: number; angle: number }) => {
      const a = createFramebuffer();
      const b = createFramebuffer();
      renderWalls(a, room, pose, textures, roomLit);
      renderWalls(b, room, pose, textures, roomMatte);
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
    renderWalls(shiny, blue, pose, textures, blueLit);
    renderWalls(plain, blue, pose, textures, {
      ...blueLit,
      wallLamp: new Int16Array(blueLit.wallLamp.length).fill(-1),
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
    wallLamp: new Int16Array(hallLit.wallLamp.length).fill(-1),
    floorLamp: new Int16Array(hallLit.floorLamp.length).fill(-1),
  };
  const pose = { x: 2.5, y: 2.5, angle: 0 };
  const channels = (c: number) => [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff];
  const shiny = createFramebuffer();
  const plain = createFramebuffer();
  renderWalls(shiny, hall, pose, textures, hallLit);
  renderWalls(plain, hall, pose, textures, hallMatte);

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
    wallLamp: new Int16Array(hallLit.wallLamp.length).fill(-1),
    floorLamp: new Int16Array(hallLit.floorLamp.length).fill(-1),
  };
  // Close to the top wall, so the wall shines too.
  const pose = { x: 2.5, y: 1.3, angle: 0 };
  const render = (mode: 'none' | 'walls' | 'both' | 'matte') => {
    const fb = createFramebuffer();
    renderWalls(fb, hall, pose, textures, mode === 'matte' ? hallMatte : hallLit, mode === 'matte' ? 'none' : mode);
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
});

describe('renderWalls floor reflections in shadow', () => {
  // One lamp beyond a pillar: the pillar shades the floor behind it from the lamp. Its light reaches the whole hall,
  // so floor with only ambient light is in its shadow, not just out of reach.
  const hall = parseMap('1111111111111\n1...........1\n1S.....1....1\n1...........1\n1111111111111');
  const hallLit = bakeLighting(hall, [{ x: 9.5, y: 2.5, z: 0.85, radius: 20, r: 1, g: 1, b: 1 }], 0.45, FLOOR, CEILING);
  const hallMatte = {
    ...hallLit,
    wallLamp: new Int16Array(hallLit.wallLamp.length).fill(-1),
    floorLamp: new Int16Array(hallLit.floorLamp.length).fill(-1),
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
      renderWalls(shiny, hall, pose, textures, hallLit);
      renderWalls(plain, hall, pose, textures, hallMatte);
      for (let i = (plain.height / 2) * plain.width; i < plain.pixels.length; i++) {
        if (plain.pixels[i] === shadow) {
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
    renderWalls(fb, room, pose, textures, roomLit, 'both', glows);
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
    renderWalls(fb, hall, pose, textures, lm, mode, glows);
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
