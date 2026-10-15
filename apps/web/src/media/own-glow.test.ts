import { describe, expect, test } from 'vitest';
import { rgb } from '../renderer/framebuffer';
import { averageRgba, createOwnGlowSampler, OWN_GLOW_MS } from './own-glow';

describe('averageRgba', () => {
  test('averages RGBA bytes into a packed colour', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
    expect(averageRgba(data)).toBe(rgb(128, 0, 128));
  });
});

describe('createOwnGlowSampler', () => {
  /** A fake document whose canvases report one colour and count their draws. */
  const fakeDocument = (red: number) => {
    let draws = 0;
    const ctx = {
      drawImage: () => {
        draws++;
      },
      getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4).map((_, i) => (i % 4 === 0 ? red : 255)) }),
    };
    const doc = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } as unknown as Document;
    return { doc, draws: () => draws };
  };

  test('reads the face canvas at most every OWN_GLOW_MS, keeping the colour between', () => {
    const { doc, draws } = fakeDocument(10);
    const sampler = createOwnGlowSampler({} as CanvasImageSource, doc);
    const first = sampler.colour(0);
    expect(first).toBe(rgb(10, 255, 255));
    sampler.colour(OWN_GLOW_MS - 1);
    expect(draws()).toBe(1);
    sampler.colour(OWN_GLOW_MS);
    expect(draws()).toBe(2);
  });

  test('without a 2D context it has no colour', () => {
    const doc = { createElement: () => ({ getContext: () => null }) } as unknown as Document;
    expect(createOwnGlowSampler({} as CanvasImageSource, doc).colour(0)).toBeNull();
  });
});
