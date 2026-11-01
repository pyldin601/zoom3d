import { describe, expect, it } from 'vitest';
import {
  ADAPT_DOWN_S,
  ADAPT_UP_S,
  adaptEye,
  createExposure,
  createEye,
  eyeGain,
  GAIN_MAX,
  GAIN_MIN,
  meterFrame,
  REFERENCE,
} from './eye-adaptation';
import { createFramebuffer, rgb } from './framebuffer';

function greyFrame(grey: number, w = 640, h = 360) {
  const fb = createFramebuffer(w, h);
  fb.pixels.fill(rgb(grey, grey, grey));
  return fb;
}

function fillBlock(fb: ReturnType<typeof createFramebuffer>, x0: number, y0: number, w: number, h: number, c: number) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      fb.pixels[y * fb.width + x] = c;
    }
  }
}

describe('meterFrame', () => {
  it('of a uniform grey frame reads that grey luma', () => {
    expect(meterFrame(greyFrame(100))).toBeCloseTo(100, 0);
  });

  it('of a black frame reads 0', () => {
    expect(meterFrame(greyFrame(0))).toBeCloseTo(0, 6);
  });

  it('reads a bright centre higher than the same bright patch at the edge', () => {
    const white = rgb(255, 255, 255);
    const centre = greyFrame(40);
    fillBlock(centre, 320 - 32, 180 - 18, 64, 36, white);
    const corner = greyFrame(40);
    fillBlock(corner, 0, 0, 64, 36, white);
    expect(meterFrame(centre)).toBeGreaterThan(meterFrame(corner));
  });

  it('is hardly moved by a small bright patch', () => {
    const fb = greyFrame(60);
    fillBlock(fb, 320 - 48, 180 - 24, 96, 48, rgb(255, 255, 255));
    expect(meterFrame(fb)).toBeLessThan(60 * 1.25);
  });

  it('reads any frame size', () => {
    expect(meterFrame(greyFrame(90, 320, 180))).toBeCloseTo(meterFrame(greyFrame(90, 640, 360)), 0);
  });
});

describe('adaptEye', () => {
  it('takes the first reading as is', () => {
    const eye = createEye();
    adaptEye(eye, 123, 0.016);
    expect(eye.level).toBe(123);
  });

  it('rises faster than it falls', () => {
    const up = { level: 50 as number | null };
    adaptEye(up, 150, 0.3);
    const down = { level: 150 as number | null };
    adaptEye(down, 50, 0.3);
    expect((up.level as number) - 50).toBeGreaterThan(150 - (down.level as number));
    expect(ADAPT_UP_S).toBeLessThan(ADAPT_DOWN_S);
  });

  it('is independent of the frame rate', () => {
    const steps = { level: 50 as number | null };
    for (let i = 0; i < 10; i++) {
      adaptEye(steps, 150, 0.03);
    }
    const once = { level: 50 as number | null };
    adaptEye(once, 150, 0.3);
    expect(steps.level as number).toBeCloseTo(once.level as number, 9);
  });

  it('lands on the reading with a huge dt', () => {
    const eye = { level: 10 as number | null };
    adaptEye(eye, 200, 1000);
    expect(eye.level).toBeCloseTo(200, 9);
  });

  it('stays put with dt 0 or below', () => {
    const eye = { level: 10 as number | null };
    adaptEye(eye, 200, 0);
    adaptEye(eye, 200, -1);
    expect(eye.level).toBe(10);
  });

  it('stays put with dt NaN', () => {
    const eye = { level: 10 as number | null };
    adaptEye(eye, 200, Number.NaN);
    expect(eye.level).toBe(10);
  });

  it('never takes a NaN reading', () => {
    const adapted = { level: 10 as number | null };
    adaptEye(adapted, Number.NaN, 0.016);
    expect(adapted.level).toBe(10);
    const fresh = createEye();
    adaptEye(fresh, Number.NaN, 0.016);
    expect(fresh.level).toBeNull();
  });
});

describe('eyeGain', () => {
  it('is 1 at REFERENCE and with no level', () => {
    expect(eyeGain(REFERENCE)).toBeCloseTo(1, 9);
    expect(eyeGain(null)).toBe(1);
  });

  it('clamps to GAIN_MAX at 0 and GAIN_MIN at 255', () => {
    expect(eyeGain(0)).toBe(GAIN_MAX);
    expect(eyeGain(255)).toBe(GAIN_MIN);
  });

  it('is never NaN', () => {
    for (const level of [0, 1e-12, 1, 90, 255, 1e9]) {
      expect(Number.isNaN(eyeGain(level))).toBe(false);
    }
  });
});

describe('createExposure', () => {
  it('apply at gain 1 changes no pixel', () => {
    const fb = greyFrame(77, 8, 8);
    fb.pixels[3] = rgb(10, 200, 33);
    const before = fb.pixels.slice();
    createExposure().apply(fb, 1);
    expect(fb.pixels).toEqual(before);
  });

  it('apply at a gain within a step of 1 changes no pixel', () => {
    const fb = greyFrame(200, 8, 8);
    const before = fb.pixels.slice();
    createExposure().apply(fb, 1.005);
    expect(fb.pixels).toEqual(before);
  });

  it('apply at gain 2 doubles a dark pixel', () => {
    const fb = greyFrame(0, 4, 4);
    fb.pixels[0] = rgb(20, 30, 40);
    createExposure().apply(fb, 2);
    expect(fb.pixels[0]).toBe(rgb(40, 60, 80));
  });

  it('clamps 200 at 255 and keeps alpha', () => {
    const fb = greyFrame(0, 4, 4);
    fb.pixels[0] = (rgb(200, 100, 10) & 0x80ffffff) >>> 0;
    createExposure().apply(fb, 2);
    const p = fb.pixels[0] as number;
    expect(p & 0xff).toBe(255);
    expect((p >>> 8) & 0xff).toBe(200);
    expect((p >>> 16) & 0xff).toBe(20);
    expect(p >>> 24).toBe(0x80);
  });
});
