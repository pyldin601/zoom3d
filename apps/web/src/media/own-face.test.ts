import { describe, expect, test } from 'vitest';
import { FACE_SIZE } from './faces';
import { createOwnFaceSampler, OWN_FACE_READ } from './own-face';
import { VIDEO_POLL_MS } from './video-frames';

describe('createOwnFaceSampler', () => {
  /** A fake document whose canvases report one byte value everywhere and count their draws. */
  const fakeDocument = () => {
    let draws = 0;
    const ctx = {
      drawImage: () => {
        draws++;
      },
      getImageData: () => ({ data: new Uint8ClampedArray(OWN_FACE_READ * OWN_FACE_READ * 4).fill(draws) }),
    };
    const doc = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } as unknown as Document;
    return { doc, draws: () => draws };
  };

  test('reads the face canvas at most once per video frame, into the same texture', () => {
    const { doc, draws } = fakeDocument();
    const sampler = createOwnFaceSampler({} as CanvasImageSource, doc);
    const first = sampler.texels(0);
    expect(first?.length).toBe(FACE_SIZE * FACE_SIZE);
    expect(first?.at(0)).toBe(0x01010101);
    sampler.texels(VIDEO_POLL_MS - 1);
    expect(draws()).toBe(1);
    expect(sampler.texels(VIDEO_POLL_MS)).toBe(first);
    expect(draws()).toBe(2);
    expect(first?.at(0)).toBe(0x02020202);
  });

  test('each texel read fills a 2×2 block of the texture', () => {
    const read = new Uint8ClampedArray(OWN_FACE_READ * OWN_FACE_READ * 4);
    // The second texel of the second row.
    read.set([9, 9, 9, 9], (OWN_FACE_READ + 1) * 4);
    const ctx = { drawImage: () => {}, getImageData: () => ({ data: read }) };
    const doc = { createElement: () => ({ getContext: () => ctx }) } as unknown as Document;
    const texels = createOwnFaceSampler({} as CanvasImageSource, doc).texels(0);
    const nines = [...(texels ?? [])].flatMap((t, i) => (t === 0x09090909 ? [i] : []));
    expect(nines).toEqual([2 * FACE_SIZE + 2, 2 * FACE_SIZE + 3, 3 * FACE_SIZE + 2, 3 * FACE_SIZE + 3]);
  });

  test('without a 2D context it has no face', () => {
    const doc = { createElement: () => ({ getContext: () => null }) } as unknown as Document;
    expect(createOwnFaceSampler({} as CanvasImageSource, doc).texels(0)).toBeNull();
  });
});
