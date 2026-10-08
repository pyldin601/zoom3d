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
