import { LEVEL1, parseMap } from '@zoom3d/shared';
import { test } from 'vitest';
import { createFramebuffer } from './framebuffer';
import { makeTextures } from './textures';
import { renderWalls } from './walls';

const map = parseMap(LEVEL1);
const fb = createFramebuffer();
const textures = makeTextures(1);
let angle = 0;

test('renderWalls 640x360 on LEVEL1 from spawn', async ({ bench }) => {
  await bench('renderWalls', () => {
    angle += 0.05;
    renderWalls(fb, map, { x: map.spawn.x + 0.5, y: map.spawn.y + 0.5, angle }, textures);
  }).run();
});

test('renderWalls + 7 face avatars around the player', async ({ bench }) => {
  const { renderSprites } = await import('./sprites');
  const cx = map.spawn.x + 0.5;
  const cy = map.spawn.y + 0.5;
  const sprites = Array.from({ length: 7 }, (_, i) => ({
    x: cx + Math.cos(i) * 1.5,
    y: cy + Math.sin(i) * 1.5,
    color: 0xff0000ff,
    face: new Uint32Array(256 * 256).fill(0xff808080),
    speaking: 0.5,
    bob: 0.5,
    itemBob: 0.5,
    sip: 0,
    held: 'beer' as const,
  }));
  await bench('walls+7 sprites', () => {
    angle += 0.05;
    const p = { x: cx, y: cy, angle };
    renderWalls(fb, map, p, textures);
    renderSprites(fb, p, sprites);
  }).run();
});
