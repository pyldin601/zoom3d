// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Detector } from './face-detector';
import { createFramer, createFrameStep } from './framer';
import type { Rect } from './framing';

const video = (w = 640, h = 480) => ({ videoWidth: w, videoHeight: h }) as HTMLVideoElement;
const face = { x: 280, y: 200, w: 80, h: 100 };
function harness() {
  const rects: Rect[] = [];
  const s = createFrameStep((_, r) => rects.push({ ...r }));
  return { s, rects };
}

test('without a detector every frame draws the centred square', () => {
  const { s, rects } = harness();
  s.step(video(), 0);
  s.step(video(), 40);
  expect(rects).toEqual([
    { x: 80, y: 0, size: 480 },
    { x: 80, y: 0, size: 480 },
  ]);
});

test('detection runs at most once a second and gets the video and time', () => {
  const { s } = harness();
  const detect = vi.fn<Detector['detect']>(() => face);
  s.setDetector({ detect });
  const v = video();
  for (const t of [0, 250, 500, 999, 1000, 1500, 1999, 2000]) {
    s.step(v, t);
  }
  expect(detect.mock.calls).toEqual([
    [v, 0],
    [v, 1000],
    [v, 2000],
  ]);
});

test('a detector that throws is dropped and the crop returns to centre', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { s, rects } = harness();
  const detect = vi.fn<Detector['detect']>(() => face);
  s.setDetector({ detect });
  for (let t = 0; t <= 2000; t += 40) {
    s.step(video(), t);
  }
  detect.mockImplementation(() => {
    throw new Error('context lost');
  });
  for (let t = 2040; t <= 12_000; t += 40) {
    s.step(video(), t);
  }
  expect(detect).toHaveBeenCalledTimes(4); // good at 0, 1000, 2000; throws at 3000
  expect(warn).toHaveBeenCalledTimes(1);
  const last = rects.at(-1) as Rect;
  expect(last.size).toBeCloseTo(480, 1);
  expect(last.x).toBeCloseTo(80, 1);
  warn.mockRestore();
});

test('step builds framing from the real video size', () => {
  const { s, rects } = harness();
  s.step(video(480, 640), 0);
  expect(rects.at(-1)).toEqual({ x: 0, y: 80, size: 480 });
  s.step(video(1280, 720), 40);
  expect(rects.at(-1)).toEqual({ x: 280, y: 0, size: 720 });
});

test('step skips frames before the video has a size', () => {
  const { s, rects } = harness();
  const detect = vi.fn<Detector['detect']>(() => face);
  s.setDetector({ detect });
  s.step(video(0, 0), 0);
  expect(rects).toEqual([]);
  expect(detect).not.toHaveBeenCalled();
});

describe('createFramer', () => {
  const canvasTrack = () => ({ kind: 'video', id: 'canvas', enabled: true }) as unknown as MediaStreamTrack;
  const raw = (id: string) => ({ kind: 'video', id, enabled: true }) as unknown as MediaStreamTrack;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    // happy-dom's MediaStream keeps no tracks; srcObject only accepts its instances.
    vi.stubGlobal(
      'MediaStream',
      class extends MediaStream {
        constructor(readonly tracks: MediaStreamTrack[]) {
          super();
        }
      }
    );
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const track = canvasTrack();
    vi.spyOn(HTMLCanvasElement.prototype, 'captureStream').mockImplementation(
      () => ({ getVideoTracks: () => [track] }) as unknown as MediaStream
    );
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const make = () => createFramer({ container: document.body, document, loadDetector: async () => null });

  test('the canvas track exists without a camera and is disabled until one is set', () => {
    const f = make();
    expect(f.track.id).toBe('canvas');
    expect(f.camera).toBeNull();
    expect(f.track.enabled).toBe(false);
    expect(f.sendTrack).toBe(f.track);
  });

  test('setCamera swaps the video source and fires onSendTrackChange', () => {
    const f = make();
    const changed = vi.fn();
    f.onSendTrackChange = changed;
    const a = raw('a');
    f.setCamera(a);
    const video = document.body.querySelector('video') as HTMLVideoElement;
    expect(f.camera).toBe(a);
    expect(f.track.enabled).toBe(true);
    expect((video.srcObject as unknown as { tracks: MediaStreamTrack[] }).tracks).toEqual([a]);
    expect(changed).toHaveBeenCalledTimes(1);
    f.setCamera(null);
    expect(f.camera).toBeNull();
    expect(f.track.enabled).toBe(false);
    expect(video.srcObject).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  test('while hidden, sendTrack is the camera; with no camera it is the canvas', () => {
    const f = make();
    const changed = vi.fn();
    f.onSendTrackChange = changed;
    const a = raw('a');
    f.setCamera(a);
    visibility = 'hidden';
    expect(f.sendTrack).toBe(a);
    f.setCamera(null);
    expect(f.sendTrack).toBe(f.track);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
