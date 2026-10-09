import { hasLineOfSight, isWallAt } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { FACE_SIZE } from '../media/faces';
import { createFramebuffer, rgb } from '../renderer/framebuffer';
import { AVATAR_RADIUS, hexToRgb, type Projection, projectSprite } from '../renderer/sprites';
import { makeTextures } from '../renderer/textures';
import { renderWalls } from '../renderer/walls';
import {
  FACE_GRID,
  FACE_PALETTE,
  faceTexels,
  LANDING_CAMERA,
  LANDING_MAP,
  LANDING_PEOPLE,
  renderLandingScene,
} from './landing-scene';

const byName = (name: string) => LANDING_PEOPLE.find((p) => p.name === name) as (typeof LANDING_PEOPLE)[number];

test('every face is a square grid of palette letters', () => {
  for (const p of LANDING_PEOPLE) {
    expect(p.face).toHaveLength(FACE_GRID);
    for (const row of p.face) {
      expect(row).toHaveLength(FACE_GRID);
      for (const ch of row) {
        expect(ch === '.' || ch in FACE_PALETTE).toBe(true);
      }
    }
  }
});

test('a face fills the texture: background in the person colour, cells scaled up', () => {
  const max = byName('Max');
  const texels = faceTexels(max);
  expect(texels).toHaveLength(FACE_SIZE * FACE_SIZE);
  expect(texels[0]).toBe(hexToRgb(max.color));
  // Row 1 starts its outline at column 5 (`.....kkkkkk.....`): one cell is FACE_SIZE / FACE_GRID texels.
  const cell = FACE_SIZE / FACE_GRID;
  expect(texels[(cell + 1) * FACE_SIZE + 5 * cell + 1]).toBe(hexToRgb(FACE_PALETTE.k));
});

test('everyone stands on the floor, clear of the walls', () => {
  for (const p of LANDING_PEOPLE) {
    for (const [dx, dy] of [
      [0, 0],
      [AVATAR_RADIUS, 0],
      [-AVATAR_RADIUS, 0],
      [0, AVATAR_RADIUS],
      [0, -AVATAR_RADIUS],
    ] as const) {
      expect(isWallAt(LANDING_MAP, p.x + dx, p.y + dy), p.name).toBe(false);
    }
  }
});

test('the camera sees every disc whole, none cut by a wall', () => {
  const fb = createFramebuffer();
  renderWalls(fb, LANDING_MAP, LANDING_CAMERA, makeTextures(1));
  const proj: Projection = { screenX: 0, depth: 0, size: 0 };
  for (const p of LANDING_PEOPLE) {
    expect(projectSprite(LANDING_CAMERA, p.x, p.y, fb.width, proj), p.name).toBe(true);
    const left = Math.floor(proj.screenX - proj.size / 2);
    const right = Math.ceil(proj.screenX + proj.size / 2);
    expect(left, p.name).toBeGreaterThanOrEqual(0);
    expect(right, p.name).toBeLessThanOrEqual(fb.width);
    for (let col = left; col < right; col++) {
      expect(fb.zbuffer[col] as number, `${p.name} at column ${col}`).toBeGreaterThan(proj.depth);
    }
  }
});

test('the one with the beer is hidden from the others by a wall', () => {
  const max = byName('Max');
  expect(max.held).toBe('beer');
  for (const p of LANDING_PEOPLE) {
    if (p !== max) {
      expect(hasLineOfSight(LANDING_MAP, p.x, p.y, max.x, max.y), p.name).toBe(false);
    }
  }
  expect(hasLineOfSight(LANDING_MAP, byName('Ada').x, byName('Ada').y, byName('Bob').x, byName('Bob').y)).toBe(true);
});

test('the scene draws walls and the people over them', () => {
  const fb = createFramebuffer();
  renderLandingScene(fb);
  expect(fb.zbuffer.every((d) => d > 0)).toBe(true);
  const proj: Projection = { screenX: 0, depth: 0, size: 0 };
  const ada = byName('Ada');
  projectSprite(LANDING_CAMERA, ada.x, ada.y, fb.width, proj);
  const centre = fb.pixels[(fb.height / 2) * fb.width + Math.round(proj.screenX)];
  expect(centre).not.toBe(rgb(0, 0, 0));
  expect(Object.values(FACE_PALETTE).map(hexToRgb).concat(hexToRgb(ada.color))).toContain(centre);
});
