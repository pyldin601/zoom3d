import {
  applyAngle,
  applyPoint,
  type GameMap,
  invert,
  LEVEL1,
  type PlayerState,
  type Portal,
  type Portals,
  parseMap,
  type RigidTransform,
} from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { twoDoorways } from '../../../../packages/shared/src/portals/test-doorways';
import { PORTAL_PINK } from '../game/portal-pulse';
import type { PeerFacts } from '../media/interest';
import { type RoomScene, renderView } from './frame';
import { createFramebuffer, type Framebuffer, rgb } from './framebuffer';
import { bakeLighting, corridorLights, type Lighting } from './lighting';
import { VACUUM_MODEL } from './models/vacuum';
import { shimmerAndRim, toSketchPx, windowRipple } from './portal-window';
import type { Sprite } from './sprites';
import { makeTextures } from './textures';
import { CEILING, FLOOR, renderWalls, rowsCovered } from './walls';

const textures = makeTextures(1);

function person(key: string, x: number, y: number, color: number): Sprite {
  return {
    key,
    x,
    y,
    color,
    face: null,
    speaking: 0.4,
    bob: 0.3,
    itemBob: 0.3,
    sip: 0,
    cheers: 0,
    wobble: 0,
    held: 'beer',
    boombox: true,
  };
}

function hashOf(fb: Framebuffer): number {
  let hash = 0;
  for (const c of fb.pixels) {
    hash = (Math.imul(hash, 31) + c) | 0;
  }
  return hash;
}

describe('renderView without portals', () => {
  const map = parseMap(LEVEL1);
  const lighting = bakeLighting(map, corridorLights(map), 0.08, FLOOR, CEILING);
  const sx = map.spawn.x + 0.5;
  const sy = map.spawn.y + 0.5;
  const sceneAt = (angle: number, lit: boolean): RoomScene => ({
    map,
    textures,
    eye: { x: sx, y: sy, angle },
    lighting: lit ? lighting : null,
    reflections: 'both',
    people: [
      person('a', sx + 1.6, sy + 0.4, rgb(220, 40, 40)),
      person('b', sx - 1.2, sy + 1.1, rgb(40, 200, 90)),
      person('c', sx + 0.3, sy - 1.7, rgb(60, 80, 230)),
    ],
    objects: [{ model: VACUUM_MODEL, x: sx + 1.1, y: sy - 0.6, angle: 0.7 }],
    labels: [],
    ownGlow: { x: sx, y: sy, face: null, color: rgb(250, 220, 120) },
    portalPulse: 1,
    portalTime: 0,
    firstPerson: null,
  });

  // Hashes taken before portals reached the renderer: with none, every pixel must stay as it was.
  test.each([
    ['unlit', false, [1134254763, -455501490, -1353213516]],
    ['lit', true, [-305545625, 661863139, -625539523]],
  ] as const)('draws the %s room exactly as before', (_, lit, expected) => {
    const fb = createFramebuffer();
    const hashes = [0, 2.1, 4.4].map((angle) => {
      renderView(fb, sceneAt(angle, lit));
      return hashOf(fb);
    });
    expect(hashes).toEqual(expected);
  });
});

const SOUTH = Math.PI / 2;
const RED = rgb(255, 0, 0);
const BLACK = 0xff000000;
const CENTRE_COL = 320;
const EYE_ROW = 180;

/** A flat disc with nothing in its hands, standing still. */
function plainPerson(key: string, x: number, y: number): Sprite {
  return { ...person(key, x, y, RED), speaking: 0, bob: 0, itemBob: 0, held: null, boombox: false };
}

function portalScene(
  map: GameMap,
  portals: Portals | null,
  eye: PlayerState,
  people: readonly Sprite[] = [],
  lighting: Lighting | null = null
): RoomScene {
  return {
    map,
    textures,
    eye,
    lighting,
    reflections: 'both',
    people,
    objects: [],
    labels: [],
    ownGlow: null,
    portalPulse: 1,
    portalTime: 0,
    firstPerson: null,
    portals,
  };
}

/** Where a portal's opening meets the floor and ceiling, `planeDepth` tiles along the view: rows, maybe off-frame. */
function openingRows(fb: Framebuffer, planeDepth: number): { top: number; bottom: number } {
  const openingPx = fb.width / 2 / Math.tan(fb.fov / 2) / planeDepth;
  return { top: fb.height / 2 - openingPx / 2, bottom: fb.height / 2 + openingPx / 2 };
}

/**
 * `pixel` as one window shows it on the centre column, at pulse 1 and time 0: far from the opening's sides there, so
 * only its top and bottom light the rim.
 */
function shimmeredAtCentre(
  pixel: number,
  row: number,
  opening: { top: number; bottom: number },
  width: number
): number {
  const rowCentre = row + 0.5;
  // The first copied row can start just above the opening's top: there the rim is at its edge.
  const edge = Math.max(0, toSketchPx(Math.min(rowCentre - opening.top, opening.bottom - rowCentre), width));
  return shimmerAndRim(pixel, 1, windowRipple(row, CENTRE_COL, width, 0), edge);
}

function throughPortal(t: RigidTransform, eye: PlayerState): PlayerState {
  const at = applyPoint(t, eye.x, eye.y, { x: 0, y: 0 });
  return { x: at.x, y: at.y, angle: applyAngle(t, eye.angle) };
}

const pixelAt = (fb: Framebuffer, col: number, row: number) => fb.pixels.at(row * fb.width + col) ?? 0;

describe('renderView through a portal', () => {
  // Looking south at A from its front, two tiles before its plane; B's far side gets wood, the hall's south wall stone.
  const { map, portals, atoB } = twoDoorways();
  map.tiles.fill(2, 0, map.width);
  const eye: PlayerState = { x: 2.5, y: 1.5, angle: SOUTH };
  const PLANE_DEPTH = 2;
  const lighting = bakeLighting(
    map,
    [{ x: 3.5, y: 5.5, z: 0.85, radius: 4.5, r: 1, g: 0.9, b: 0.8 }],
    0.3,
    FLOOR,
    CEILING
  );

  /** What A's window shows on columns [fromCol, toCol), drawn alone from toDest(eye), past a plane that deep. */
  function roomBeyondA(
    eye: PlayerState,
    planeDepth: number,
    fromCol: number,
    toCol: number,
    lit: Lighting | null
  ): Framebuffer {
    const beyond = createFramebuffer();
    const nearDepth = new Float64Array(beyond.width).fill(planeDepth);
    renderWalls(beyond, {
      map,
      textures,
      eye: throughPortal(atoB, eye),
      lighting: lit,
      portals,
      pass: { fromCol, toCol, nearDepth, lastLevel: false },
    });
    return beyond;
  }

  test.each([
    ['unlit', null],
    ['lit', lighting],
  ] as const)(
    'the window shows the room beyond B, as seen from toDest(eye) past its plane, shimmered (%s)',
    (_, lit) => {
      const fb = createFramebuffer();
      renderView(fb, portalScene(map, portals, eye, [], lit));
      // The same columns as the window's: the floor is stepped along a row from the pass's first column.
      const fromCol = fb.portalAt.indexOf(0);
      const toCol = fb.portalAt.lastIndexOf(0) + 1;
      expect(fromCol).toBeLessThan(CENTRE_COL);
      expect(toCol).toBeGreaterThan(CENTRE_COL);
      const beyond = roomBeyondA(eye, PLANE_DEPTH, fromCol, toCol, lit);
      const window = rowsCovered(fb.height, fb.width / 2 / Math.tan(fb.fov / 2) / PLANE_DEPTH);
      const opening = openingRows(fb, PLANE_DEPTH);
      for (let row = window.start; row < window.end; row++) {
        expect(pixelAt(fb, CENTRE_COL, row)).toBe(
          shimmeredAtCentre(pixelAt(beyond, CENTRE_COL, row), row, opening, fb.width)
        );
      }
      const plainDoor = createFramebuffer();
      renderView(plainDoor, portalScene(map, null, eye, [], lit));
      expect(pixelAt(fb, CENTRE_COL, EYE_ROW)).not.toBe(pixelAt(plainDoor, CENTRE_COL, EYE_ROW));
    }
  );

  test('close to the plane the opening runs past the frame: its top row is shimmered, with no rim', () => {
    const close: PlayerState = { x: 2.5, y: 3, angle: SOUTH };
    const fb = createFramebuffer();
    renderView(fb, portalScene(map, portals, close));
    const fromCol = fb.portalAt.indexOf(0);
    const toCol = fb.portalAt.lastIndexOf(0) + 1;
    const beyond = roomBeyondA(close, 0.5, fromCol, toCol, null);
    const shimmerOnly = shimmerAndRim(pixelAt(beyond, CENTRE_COL, 0), 1, windowRipple(0, CENTRE_COL, fb.width, 0), 1e9);
    expect(pixelAt(fb, CENTRE_COL, 0)).toBe(shimmerOnly);
  });

  test('the z-buffer holds the depth beyond the window, for the labels', () => {
    const fb = createFramebuffer();
    renderView(fb, portalScene(map, portals, eye));
    // From toDest(eye), (4.5, 5.5) facing north, the hall's north wall's face at y = 1.
    expect(fb.zbuffer[CENTRE_COL]).toBeCloseTo(4.5);
  });

  test('a person between the virtual eye and B is not drawn in the window; one just past B is', () => {
    // toDest(eye) is (4.5, 5.5) facing north; B's plane lies at y = 3.5.
    const between = createFramebuffer();
    renderView(between, portalScene(map, portals, eye, [plainPerson('between', 4.5, 4.5)]));
    expect(pixelAt(between, CENTRE_COL, EYE_ROW)).not.toBe(RED);
    const past = createFramebuffer();
    renderView(past, portalScene(map, portals, eye, [plainPerson('past', 4.5, 3.4)]));
    expect(pixelAt(past, CENTRE_COL, EYE_ROW)).toBe(
      shimmeredAtCentre(RED, EYE_ROW, openingRows(past, PLANE_DEPTH), past.width)
    );
  });

  test('seen facts count a person drawn only through the window', () => {
    const someone = plainPerson('someone', 4.5, 2.9);
    const seen = new Map<string, PeerFacts>();
    renderView(createFramebuffer(), portalScene(map, null, eye, [someone]), seen);
    expect(seen.get('someone')?.drawnColumns).toBe(0);
    renderView(createFramebuffer(), portalScene(map, portals, eye, [someone]), seen);
    expect(seen.get('someone')?.drawnColumns).toBeGreaterThan(0);
    expect(seen.get('someone')?.projectedSize).toBeGreaterThan(0);
  });
});

/**
 * A corridor running south through doorways every three tiles, from y = 3. Each portal's front faces north, and it
 * leads three tiles south, onto the next doorway: looking south, every window shows the next one.
 */
function doorwayChain(count: number): { map: GameMap; portals: Portals } {
  const rows = ['11111', '1...1', '1.S.1'];
  for (let k = 0; k < count; k++) {
    rows.push('11.11', '1...1', '1...1');
  }
  rows.push('11111');
  const map = parseMap(rows.join('\n'));
  const threeSouth: RigidTransform = { cos: 1, sin: 0, tx: 0, ty: 3 };
  const list: Portal[] = Array.from({ length: count }, (_, k) => ({
    door: { x: 2, y: 3 + 3 * k, axis: 'ns' },
    cx: 2.5,
    cy: 3.5 + 3 * k,
    nx: 0,
    ny: 1,
    to: Math.min(k + 1, count - 1),
    toDest: threeSouth,
    fromDest: invert(threeSouth),
  }));
  const byTile = new Int32Array(map.width * map.height).fill(-1);
  list.forEach((p, k) => {
    byTile[p.door.y * map.width + p.door.x] = k;
  });
  return { map, portals: { map, list, byTile } };
}

describe('windows within windows', () => {
  // The first window shows the second doorway's back and the third's front; that window shows the fourth's back and
  // the fifth's front: a third window, past the last level.
  const { map, portals } = doorwayChain(5);

  test('past the last level, a window shows only its windows’ pink, frame after frame', () => {
    const fb = createFramebuffer();
    for (const eye of [
      { x: 2.5, y: 1.5, angle: SOUTH },
      { x: 2.45, y: 1.6, angle: SOUTH + 0.01 },
    ]) {
      renderView(fb, portalScene(map, portals, eye));
      const shown = pixelAt(fb, CENTRE_COL, EYE_ROW);
      const red = shown & 0xff;
      expect(red).toBeGreaterThan(0);
      expect(((shown >>> 8) & 0xff) / red).toBeCloseTo(PORTAL_PINK.g / PORTAL_PINK.r, 1);
      expect(((shown >>> 16) & 0xff) / red).toBeCloseTo(PORTAL_PINK.b / PORTAL_PINK.r, 1);
    }
  });

  test('the second window is drawn', () => {
    const fb = createFramebuffer();
    renderView(fb, portalScene(map, portals, { x: 2.5, y: 1.5, angle: SOUTH }));
    // The second window's plane is 5 tiles deep, the third's 8: rows between their walls show the second's room.
    const proj = fb.width / 2 / Math.tan(fb.fov / 2);
    const second = rowsCovered(fb.height, proj / 5);
    const row = second.start + 1;
    expect(rowsCovered(fb.height, proj / 8).start).toBeGreaterThan(row);
    expect(pixelAt(fb, CENTRE_COL, row)).not.toBe(BLACK);
  });
});
