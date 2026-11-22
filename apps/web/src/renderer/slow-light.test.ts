import { FOV_TALL, FOV_WIDE } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { createFramebuffer, rgb } from './framebuffer';
import { createBend } from './slow-light';
import { type Motion, SOURCE_FOV } from './slow-light-math';

const still: Motion = { beta: 0, angle: 0 };
const proj = (width: number, fov: number) => width / 2 / Math.tan(fov / 2);
const channels = (c: number) => ({ r: c & 0xff, g: (c >>> 8) & 0xff, b: (c >>> 16) & 0xff });

test('fit keeps one source frame until the output changes', () => {
  const bend = createBend();
  const out = createFramebuffer(640, 360, FOV_WIDE);
  const source = bend.fit(out);
  expect(bend.fit(out)).toBe(source);
  expect([source.width, source.height, source.fov]).toEqual([1280, 360, SOURCE_FOV]);
  expect(bend.fit(createFramebuffer(640, 360, FOV_TALL))).not.toBe(source);
});

test('at rest the tables only widen the view', () => {
  const bend = createBend();
  const out = createFramebuffer(640, 360, FOV_WIDE);
  bend.aim(out, still);
  for (let col = 0; col < 640; col++) {
    expect([bend.gainR.at(col), bend.gainG.at(col), bend.gainB.at(col)]).toEqual([1, 1, 1]);
    if (col > 0) {
      expect(bend.sourceCol.at(col)).toBeGreaterThanOrEqual(bend.sourceCol.at(col - 1) ?? 0);
    }
  }
  expect(Math.abs((bend.sourceCol.at(320) ?? 0) - 640)).toBeLessThanOrEqual(1);
  expect(bend.rowScale.at(320)).toBeCloseTo(proj(640, FOV_WIDE) / proj(1280, SOURCE_FOV), 2);
});

test('moving forward reads the edges from further out', () => {
  const bend = createBend();
  const out = createFramebuffer(640, 360, FOV_WIDE);
  bend.aim(out, still);
  const atRest = bend.sourceCol.at(639) ?? 0;
  bend.aim(out, { beta: 0.5, angle: 0 });
  expect(bend.sourceCol.at(639)).toBeGreaterThan(atRest);
});

test('the tables stay inside the source frame at the cap, whichever way the motion points', () => {
  for (const fov of [FOV_WIDE, FOV_TALL]) {
    const bend = createBend();
    const out = createFramebuffer(640, 360, fov);
    const width = bend.fit(out).width;
    for (let deg = 0; deg < 360; deg += 15) {
      bend.aim(out, { beta: 0.5, angle: (deg * Math.PI) / 180 });
      for (const sc of bend.sourceCol) {
        expect(sc).toBeGreaterThanOrEqual(0);
        expect(sc).toBeLessThan(width);
      }
    }
  }
});

test('apply copies a flat source unchanged at rest', () => {
  const bend = createBend();
  const out = createFramebuffer(640, 360, FOV_WIDE);
  const source = bend.fit(out);
  const colour = rgb(90, 140, 200);
  source.pixels.fill(colour);
  bend.aim(out, still);
  bend.apply(source, out);
  expect(out.pixels.every((p) => p === colour)).toBe(true);
});

test('apply tints ahead blue and behind red', () => {
  const bend = createBend();
  const out = createFramebuffer(640, 360, FOV_WIDE);
  const source = bend.fit(out);
  source.pixels.fill(rgb(120, 120, 120));
  const centre = 180 * 640 + 320;
  bend.aim(out, { beta: 0.5, angle: 0 });
  bend.apply(source, out);
  const ahead = channels(out.pixels.at(centre) ?? 0);
  expect(ahead.b).toBeGreaterThan(ahead.r);
  bend.aim(out, { beta: 0.5, angle: Math.PI });
  bend.apply(source, out);
  const behind = channels(out.pixels.at(centre) ?? 0);
  expect(behind.r).toBeGreaterThan(behind.b);
});

test('toOutputX inverts the column table', () => {
  const bend = createBend();
  const out = createFramebuffer(640, 360, FOV_WIDE);
  bend.aim(out, { beta: 0.4, angle: 0.7 });
  for (const col of [5, 100, 320, 500, 630]) {
    expect(Math.abs(bend.toOutputX((bend.sourceCol.at(col) ?? 0) + 0.5) - (col + 0.5))).toBeLessThanOrEqual(1.5);
  }
});

test('toOutputX puts a source x the frame does not show outside the frame', () => {
  const bend = createBend();
  const out = createFramebuffer(640, 360, FOV_WIDE);
  const width = bend.fit(out).width;
  bend.aim(out, still);
  expect(bend.toOutputX(0)).toBeLessThan(0);
  expect(bend.toOutputX(width - 1)).toBeGreaterThanOrEqual(640);
});

test('the source columns read span only what the frame shows', () => {
  const bend = createBend();
  const out = createFramebuffer(640, 360, FOV_WIDE);
  bend.aim(out, { beta: 0.3, angle: 0.4 });
  expect(bend.readFrom).toBe(Math.min(...bend.sourceCol));
  expect(bend.readTo).toBe(Math.max(...bend.sourceCol) + 1);
});
