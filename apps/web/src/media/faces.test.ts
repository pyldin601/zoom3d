import { describe, expect, test, vi } from 'vitest';
import { createFace, FACE_SIZE, FACE_STALL_MS, initials, squareCrop } from './faces';

test('face textures are 256 px', () => {
  expect(FACE_SIZE).toBe(256);
});

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

describe('frame buffers', () => {
  test('live frames reuse one texel buffer', () => {
    const { document } = fakeDocument();
    const face = createFace({ name: 'Ada', color: '#e6194b', document });
    const video = fakeVideo({ rvfc: true });
    face.setVideo(video as unknown as HTMLVideoElement);
    video.callback?.(10);
    face.update(10);
    const first = face.texels;
    video.callback?.(20);
    face.update(20);
    expect(face.texels).toBe(first);
  });

  test('no frames are grabbed while the camera is off', () => {
    const { document, context } = fakeDocument();
    const face = createFace({ name: 'Ada', color: '#e6194b', document });
    const video = fakeVideo({ rvfc: true });
    face.setCam(false);
    face.setVideo(video as unknown as HTMLVideoElement);
    video.callback?.(10);
    video.callback?.(20);
    expect(context.drawImage).not.toHaveBeenCalled();
  });
});

describe('avatar picture', () => {
  const PIC = 'data:image/jpeg;base64,/9j/4AAQ';
  function fakeImage(width = 128, height = 128) {
    return {
      naturalWidth: width,
      naturalHeight: height,
      src: '',
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
  }
  const withImage = (img: ReturnType<typeof fakeImage>) => () => img as unknown as HTMLImageElement;

  test('replaces the initials once it decodes, centre-cropped to the face', () => {
    const { document, context } = fakeDocument();
    const img = fakeImage(200, 100);
    const face = createFace({
      name: 'Ada',
      color: '#e6194b',
      document,
      avatar: PIC,
      createImage: withImage(img),
    });
    const initialsTexels = face.texels;
    expect(img.src).toBe(PIC);
    img.onload?.();
    expect(context.drawImage).toHaveBeenCalledWith(img, 50, 0, 100, 100, 0, 0, FACE_SIZE, FACE_SIZE);
    expect(face.texels).not.toBe(initialsTexels);
    expect(face.live()).toBe(false);
  });

  test('a picture that fails to decode keeps the initials', () => {
    const { document } = fakeDocument();
    const img = fakeImage();
    const face = createFace({
      name: 'Ada',
      color: '#e6194b',
      document,
      avatar: PIC,
      createImage: withImage(img),
    });
    const initialsTexels = face.texels;
    img.onerror?.();
    expect(face.texels).toBe(initialsTexels);
  });

  test('live video wins over the picture, which returns when the camera goes off', () => {
    const { document } = fakeDocument();
    const img = fakeImage();
    const face = createFace({
      name: 'Ada',
      color: '#e6194b',
      document,
      avatar: PIC,
      createImage: withImage(img),
    });
    img.onload?.();
    const pictureTexels = face.texels;
    face.setVideo(fakeVideo() as unknown as HTMLVideoElement);
    face.update(0);
    expect(face.live()).toBe(true);
    expect(face.texels).not.toBe(pictureTexels);
    face.setCam(false);
    expect(face.texels).toBe(pictureTexels);
  });

  test('no picture is loaded without an avatar, and a late decode after dispose is ignored', () => {
    const { document, context } = fakeDocument();
    const create = vi.fn(() => fakeImage() as unknown as HTMLImageElement);
    createFace({ name: 'Ada', color: '#e6194b', document, avatar: null, createImage: create });
    expect(create).not.toHaveBeenCalled();
    const img = fakeImage();
    const face = createFace({
      name: 'Ada',
      color: '#e6194b',
      document,
      avatar: PIC,
      createImage: withImage(img),
    });
    face.dispose();
    img.onload?.();
    expect(context.drawImage).not.toHaveBeenCalled();
  });
});
