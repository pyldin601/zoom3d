import { describe, expect, test } from 'vitest';
import { scaleRgb } from './framebuffer';

describe('scaleRgb', () => {
  test('scales each channel, rounding down, and keeps alpha', () => {
    expect(scaleRgb(0xff6464c8, 0.7)).toBe(0xff4646_8c);
    expect(scaleRgb(0x80ffffff, 0.5)).toBe(0x807f7f7f);
  });
});
