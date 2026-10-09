import { expect, test } from 'vitest';
import { type Box, createFraming, type Framing, MOUTH_Y_IN_CROP } from './framing';

const W = 640;
const H = 480;
const CENTRE = { x: 80, y: 0, size: 480 };
const face: Box = { x: 280, y: 200, w: 80, h: 100 }; // centre (320, 250) → side 176, headroom 17.6
const framed = { x: 232, y: 144.4, size: 176 };

// Ten easing time constants: settled to well under 0.05 px.
const SETTLE = 6000;

/** Feeds `box` every 100 ms from `from` for `ms`; returns a copy of the last rect. */
function settle(f: Framing, box: Box | null, from: number, ms: number) {
  let r = f.update(box, from);
  for (let t = from + 100; t <= from + ms; t += 100) {
    r = f.update(box, t);
  }
  return { ...r };
}
const close = (r: { x: number; y: number; size: number }, e: typeof r) => {
  expect(r.x).toBeCloseTo(e.x, 1);
  expect(r.y).toBeCloseTo(e.y, 1);
  expect(r.size).toBeCloseTo(e.size, 1);
};

test('starts at the centred square', () => {
  expect(createFraming(W, H).update(null, 0)).toEqual(CENTRE);
});

test('settles on a square 2.2× the face width, raised by 10% headroom', () => {
  close(settle(createFraming(W, H), face, 0, SETTLE), framed);
});

test('with a mouth keypoint, the mouth lands at the centre column, 0.72 of the way down', () => {
  expect(MOUTH_Y_IN_CROP).toBe(0.72);
  // Size still comes from the box (2.2 × 80 = 176); position from the mouth (330, 270).
  const withMouth = { ...face, mouth: { x: 330, y: 270 } };
  close(settle(createFraming(W, H), withMouth, 0, SETTLE), { x: 330 - 88, y: 270 - 0.72 * 176, size: 176 });
});

test('a mouth near the bottom edge is clamped like any crop', () => {
  const low = { x: 280, y: 380, w: 80, h: 90, mouth: { x: 320, y: 460 } };
  close(settle(createFraming(W, H), low, 0, SETTLE), { x: 232, y: 304, size: 176 });
});

test('the square is clamped inside the frame, never padded', () => {
  close(settle(createFraming(W, H), { x: 0, y: 200, w: 80, h: 100 }, 0, SETTLE), { x: 0, y: 144.4, size: 176 });
  close(settle(createFraming(W, H), { x: 560, y: 200, w: 80, h: 100 }, 0, SETTLE), { x: 464, y: 144.4, size: 176 });
  close(settle(createFraming(W, H), { x: 280, y: 0, w: 80, h: 60 }, 0, SETTLE), { x: 232, y: 0, size: 176 });
  close(settle(createFraming(W, H), { x: 280, y: 420, w: 80, h: 60 }, 0, SETTLE), { x: 232, y: 304, size: 176 });
});

test('zoom is limited to [160, min(w, h)]', () => {
  expect(settle(createFraming(W, H), { x: 300, y: 220, w: 40, h: 50 }, 0, SETTLE).size).toBeCloseTo(160, 1);
  expect(settle(createFraming(W, H), { x: 170, y: 100, w: 300, h: 360 }, 0, SETTLE).size).toBeCloseTo(480, 1);
});

test('small detector jitter inside the dead zone does not move the crop', () => {
  const f = createFraming(W, H);
  const before = settle(f, face, 0, SETTLE);
  close(settle(f, { ...face, x: face.x + 5, w: face.w + 4 }, SETTLE + 100, 2000), before);
});

test('a real move outside the dead zone is followed', () => {
  const f = createFraming(W, H);
  settle(f, face, 0, SETTLE);
  close(settle(f, { ...face, x: face.x + 40 }, SETTLE + 100, SETTLE), { ...framed, x: framed.x + 40 });
});

test('easing is time-based: one 300 ms step equals ten 30 ms steps', () => {
  const a = createFraming(W, H);
  a.update(face, 0);
  const one = { ...a.update(null, 300) };
  const b = createFraming(W, H);
  b.update(face, 0);
  let ten = b.update(null, 30);
  for (let t = 60; t <= 300; t += 30) {
    ten = b.update(null, t);
  }
  close(ten, one);
});

test('easing covers 1 − 1/e of the way in 600 ms', () => {
  const f = createFraming(W, H);
  f.update(face, 0);
  const k = 1 - Math.exp(-1);
  close(f.update(null, 600), { x: 80 + (232 - 80) * k, y: 144.4 * k, size: 480 + (176 - 480) * k });
});

test('a lost face eases back to centre after 3 s, and a returning face is tracked again', () => {
  const f = createFraming(W, H);
  settle(f, face, 0, SETTLE);
  close(settle(f, null, 6100, 2800), framed); // still within LOST_MS of the last box at 6000
  close(settle(f, null, 9100, 10_000), CENTRE);
  close(settle(f, face, 19_200, SETTLE), framed);
});

test('update reuses one rect object', () => {
  const f = createFraming(W, H);
  expect(f.update(face, 0)).toBe(f.update(null, 16));
});

test('a remembered rect is the start and is held until the face search starts', () => {
  const f = createFraming(W, H, framed);
  expect(f.update(null, 0, false)).toEqual(framed);
  for (let t = 100; t <= 20_000; t += 100) {
    f.update(null, t, false);
  }
  close(f.update(null, 20_100, false), framed);
});

test('once searching, a remembered rect is lost after 3 s without a face', () => {
  const f = createFraming(W, H, framed);
  f.update(null, 0, false);
  close(settle(f, null, 10_000, 2900), framed);
  close(settle(f, null, 13_000, SETTLE), CENTRE);
});

test('a remembered rect that does not fit the frame is ignored', () => {
  expect(createFraming(W, H, { x: 600, y: 0, size: 176 }).update(null, 0)).toEqual(CENTRE);
});

test('target is where the crop is heading', () => {
  const f = createFraming(W, H);
  f.update(face, 0);
  expect(f.target).toEqual(framed);
});
