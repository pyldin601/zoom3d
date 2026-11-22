import { FOV_TALL, FOV_WIDE } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { createFramebuffer, rgb } from './framebuffer';
import { createBend, GRID_PX, type Shown } from './slow-light';
import { aberrate, type Dir, type Motion } from './slow-light-math';

const still: Motion = { beta: 0, angle: 0 };
const channels = (c: number) => ({ r: c & 0xff, g: (c >>> 8) & 0xff, b: (c >>> 16) & 0xff });
const wide = () => createFramebuffer(640, 360, FOV_WIDE);

test('fit keeps one source frame until the output changes, taller and wider than the frame', () => {
  const bend = createBend();
  const out = wide();
  const source = bend.fit(out);
  expect(bend.fit(out)).toBe(source);
  expect(source.width).toBe(1280);
  expect(source.height).toBeGreaterThan(360);
  expect(source.fov).toBeGreaterThan(FOV_WIDE);
  expect(bend.fit(createFramebuffer(360, 640, FOV_TALL))).not.toBe(source);
});

test('every grid point reads inside the source at the cap, whichever way the motion points', () => {
  for (const out of [wide(), createFramebuffer(360, 640, FOV_TALL)]) {
    const bend = createBend();
    const source = bend.fit(out);
    for (let deg = 0; deg < 360; deg += 15) {
      bend.aim(out, { beta: 0.5, angle: (deg * Math.PI) / 180 });
      for (const x of bend.gridX) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(source.width);
      }
      for (const y of bend.gridY) {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(source.height);
      }
    }
  }
});

test('at rest a flat source is copied unchanged', () => {
  const bend = createBend();
  const out = wide();
  const source = bend.fit(out);
  const colour = rgb(90, 140, 200);
  source.pixels.fill(colour);
  bend.aim(out, still);
  bend.apply(source, out);
  // Through the colour path: within a byte of the source, below the tone shoulder.
  const at = channels(out.pixels.at(1000) ?? 0);
  expect(Math.abs(at.r - 90) + Math.abs(at.g - 140) + Math.abs(at.b - 200)).toBeLessThanOrEqual(3);
  expect(new Set(out.pixels).size).toBe(1);
});

test('between grid points the source position is within half a pixel of the exact map', () => {
  const bend = createBend();
  const out = wide();
  const source = bend.fit(out);
  const motion = { beta: 0.5, angle: 0.6 };
  bend.aim(out, motion);
  const projOut = 320 / Math.tan(FOV_WIDE / 2);
  const projSrc = source.width / 2 / Math.tan(source.fov / 2);
  const cols = bend.gridCols;
  for (const [i, j] of [
    [3, 4],
    [40, 22],
    [70, 40],
  ] as const) {
    const x = i * GRID_PX + GRID_PX / 2;
    const y = j * GRID_PX + GRID_PX / 2;
    const l = Math.hypot(1, (x - 320) / projOut, (y - 180) / projOut);
    const n: Dir = aberrate(
      { x: 1 / l, y: (x - 320) / projOut / l, z: (y - 180) / projOut / l },
      motion.angle,
      motion.beta,
      { x: 0, y: 0, z: 0 }
    );
    const exactX = source.width / 2 + (projSrc * n.y) / n.x;
    const at = (k: number) => bend.gridX.at(k) ?? 0;
    const k = j * cols + i;
    const interpolated = (at(k) + at(k + 1) + at(k + cols) + at(k + cols + 1)) / 4;
    expect(Math.abs(interpolated - exactX)).toBeLessThan(0.5);
  }
});

test('straight vertical lines bend: one frame column reads different source columns up and down', () => {
  const bend = createBend();
  bend.aim(wide(), { beta: 0.5, angle: 0 });
  const cols = bend.gridCols;
  const column = 10;
  const top = bend.gridX.at(column) ?? 0;
  const middle = bend.gridX.at(Math.floor(bend.gridRows / 2) * cols + column) ?? 0;
  expect(Math.abs(top - middle)).toBeGreaterThan(2);
});

test('ahead is brighter and bluer than behind, and a white source stays a valid colour', () => {
  const bend = createBend();
  const out = wide();
  const source = bend.fit(out);
  const centre = 180 * 640 + 320;
  source.pixels.fill(rgb(110, 110, 110));
  bend.aim(out, { beta: 0.5, angle: 0 });
  bend.apply(source, out);
  const ahead = channels(out.pixels.at(centre) ?? 0);
  bend.aim(out, { beta: 0.5, angle: Math.PI });
  bend.apply(source, out);
  const behind = channels(out.pixels.at(centre) ?? 0);
  expect(ahead.r + ahead.g + ahead.b).toBeGreaterThan(behind.r + behind.g + behind.b);
  expect(ahead.b).toBeGreaterThan(ahead.r);
  source.pixels.fill(rgb(255, 255, 255));
  bend.aim(out, { beta: 0.5, angle: 0 });
  bend.apply(source, out);
  const white = channels(out.pixels.at(centre) ?? 0);
  expect(Math.max(white.r, white.g, white.b)).toBeLessThanOrEqual(255);
  expect(white.b).toBeGreaterThan(200);
});

test('toOutput sends a grid point’s source back to it, and the unseen corner nowhere', () => {
  const bend = createBend();
  const out = wide();
  bend.fit(out);
  bend.aim(out, { beta: 0.4, angle: 0.7 });
  const shown: Shown = { x: 0, y: 0, scale: 0 };
  const cols = bend.gridCols;
  for (const [i, j] of [
    [5, 5],
    [40, 22],
    [75, 40],
  ] as const) {
    const k = j * cols + i;
    expect(bend.toOutput(bend.gridX.at(k) ?? 0, bend.gridY.at(k) ?? 0, shown)).toBe(true);
    expect(Math.abs(shown.x - i * GRID_PX)).toBeLessThan(1);
    expect(Math.abs(shown.y - j * GRID_PX)).toBeLessThan(1);
    expect(shown.scale).toBeGreaterThan(0);
  }
  expect(bend.toOutput(0, 0, shown)).toBe(false);
});

test('the read range spans the grid’s source columns', () => {
  const bend = createBend();
  bend.aim(wide(), { beta: 0.3, angle: 0.4 });
  expect(bend.readFrom).toBeLessThanOrEqual(Math.min(...bend.gridX));
  expect(bend.readTo).toBeGreaterThan(Math.max(...bend.gridX));
});

test('coming to rest changes nothing: a nearly still frame and a still one look the same', () => {
  const bend = createBend();
  const out = wide();
  const source = bend.fit(out);
  source.pixels.fill(rgb(255, 255, 255));
  bend.aim(out, { beta: 0.0001, angle: 0 });
  bend.apply(source, out);
  const nearlyStill = channels(out.pixels.at(180 * 640 + 320) ?? 0);
  bend.aim(out, still);
  bend.apply(source, out);
  const atRest = channels(out.pixels.at(180 * 640 + 320) ?? 0);
  expect(Math.abs(nearlyStill.r - atRest.r)).toBeLessThanOrEqual(1);
  expect(Math.abs(nearlyStill.b - atRest.b)).toBeLessThanOrEqual(1);
});
