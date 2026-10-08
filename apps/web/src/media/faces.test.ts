import { describe, expect, test, vi } from 'vitest';
import { createFace, FACE_SIZE, FACE_STALL_MS, initials, squareCrop } from './faces';

describe('squareCrop', () => {
  test.each([
    [160, 160, { sx: 0, sy: 0, size: 160 }],
    [640, 480, { sx: 80, sy: 0, size: 480 }],
    [480, 640, { sx: 0, sy: 80, size: 480 }],
  ])('%i x %i', (w, h, expected) => {
    expect(squareCrop(w, h)).toEqual(expected);
  });
});

describe('initials', () => {
  test.each([
    ['Ada Lovelace', 'AL'],
    ['  bob ', 'B'],
    ['Jean-Luc Picard Smith', 'JP'],
    ['', '?'],
    ['😀 x', '😀X'],
  ])('%s → %s', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

/** A fake document whose canvases fill getImageData with a per-call marker value. */
function fakeDocument() {
  let fill = 1;
  const context = {
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn(() => {
      const data = new Uint8ClampedArray(FACE_SIZE * FACE_SIZE * 4);
      data.fill(fill++);
      return { data };
    }),
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  return { document: { createElement: () => canvas } as unknown as Document, context };
}

function fakeVideo(opts: { rvfc?: boolean } = {}) {
  const video = {
    videoWidth: 160,
    videoHeight: 160,
    currentTime: 1,
    requestVideoFrameCallback: undefined as unknown,
    cancelVideoFrameCallback: vi.fn(),
    callback: null as ((now: number) => void) | null,
  };
  if (opts.rvfc) {
    video.requestVideoFrameCallback = (cb: (now: number) => void) => {
      video.callback = cb;
      return 7;
    };
  }
  return video;
}

describe('createFace', () => {
  test('starts on the initials disc and draws the initials once', () => {
    const { document, context } = fakeDocument();
    const face = createFace({ name: 'Ada Lovelace', color: '#e6194b', document });
    expect(face.live()).toBe(false);
    expect(face.texels).toHaveLength(FACE_SIZE * FACE_SIZE);
    expect(context.fillText).toHaveBeenCalledWith('AL', expect.any(Number), expect.any(Number));
  });

  test('polls video frames without requestVideoFrameCallback and falls back after a stall', () => {
    const { document } = fakeDocument();
    const face = createFace({ name: 'Ada', color: '#e6194b', document });
    const initialsTexels = face.texels;
    const video = fakeVideo();
    face.setVideo(video as unknown as HTMLVideoElement);
    face.update(0);
    expect(face.live()).toBe(true);
    expect(face.texels).not.toBe(initialsTexels);
    face.update(FACE_STALL_MS + 100);
    expect(face.live()).toBe(false);
    expect(face.texels).toBe(initialsTexels);
    video.currentTime = 2;
    face.update(FACE_STALL_MS + 200);
    expect(face.live()).toBe(true);
  });

  test('camera off shows initials even while frames arrive', () => {
    const { document } = fakeDocument();
    const face = createFace({ name: 'Ada', color: '#e6194b', document });
    const initialsTexels = face.texels;
    face.setVideo(fakeVideo() as unknown as HTMLVideoElement);
    face.setCam(false);
    face.update(0);
    expect(face.live()).toBe(false);
    expect(face.texels).toBe(initialsTexels);
  });

  test('uses requestVideoFrameCallback when available and cancels it on dispose', () => {
    const { document, context } = fakeDocument();
    const face = createFace({ name: 'Ada', color: '#e6194b', document });
    const video = fakeVideo({ rvfc: true });
    face.setVideo(video as unknown as HTMLVideoElement);
    video.callback?.(10);
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    face.update(20);
    expect(face.live()).toBe(true);
    face.dispose();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
  });
});
