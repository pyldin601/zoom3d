// Face framing glue (face-framing spec §5): plays the raw camera in a hidden <video>, detects the face once a
// second, and draws a smoothed square crop into a 256² canvas whose captureStream is what peers get. 128² and 64²
// canvases are drawn from it for peers who see us small (6c spec §3).
import { type Detector, loadFaceDetector } from './face-detector';
import { type Box, createFraming, type Framing, type Rect } from './framing';
import type { FramingMemory } from './framing-memory';
import type { FaceTracks } from './transport';
import { type FrameVideo, VIDEO_POLL_MS } from './video-frames';

export const OUTPUT_SIZE = 256;
export const OUTPUT_FPS = 24;
export const FACE_64_FPS = 15;
export const DETECT_MS = 1000;

export interface FrameStep {
  setDetector(d: Detector | null): void;
  /** The camera's device id; a new camera starts from its own remembered framing. */
  setCamera(id: string | null): void;
  step(video: HTMLVideoElement, now: number): void;
}

/** One camera frame: maybe detect, update the framing, draw. `memory` keeps the framing across page loads. */
export function createFrameStep(
  draw: (video: HTMLVideoElement, rect: Rect) => void,
  memory: FramingMemory | null = null
): FrameStep {
  let detector: Detector | null = null;
  // Until the detector has loaded (or failed to), a remembered framing is held rather than lost.
  let searching = false;
  let camera: string | null = null;
  let framing: Framing | null = null;
  let frameW = 0;
  let frameH = 0;
  let lastDetectAt = Number.NEGATIVE_INFINITY;

  return {
    setDetector(d) {
      detector = d;
      searching = true;
    },
    setCamera(id) {
      camera = id;
      framing = null;
    },
    step(video, now) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w === 0 || h === 0) {
        return;
      }
      const current = framingFor(w, h);
      const box = detectIfDue(video, now);
      const rect = current.update(box, now, searching);
      if (box && camera !== null) {
        memory?.save(camera, w, h, current.target);
      }
      draw(video, rect);
    },
  };

  /** A new camera or frame size starts from the framing remembered for it. */
  function framingFor(w: number, h: number): Framing {
    if (!framing || w !== frameW || h !== frameH) {
      framing = createFraming(w, h, camera === null ? null : (memory?.load(camera, w, h) ?? null));
      frameW = w;
      frameH = h;
    }
    return framing;
  }

  function detectIfDue(video: HTMLVideoElement, now: number): Box | null {
    if (!detector || now - lastDetectAt < DETECT_MS) {
      return null;
    }
    lastDetectAt = now;
    try {
      return detector.detect(video, now);
    } catch (err) {
      // Never retried: the crop eases back to centre once LOST_MS passes.
      console.warn('face detection failed; framing falls back to the centre', err);
      detector = null;
      return null;
    }
  }
}

export interface Framer {
  /** The framed OUTPUT_SIZE² canvas track; exists with or without a camera, disabled without one. */
  readonly track: MediaStreamTrack;
  /** The canvas `track` captures: your face as peers get it (its colour is your own glow). */
  readonly canvas: HTMLCanvasElement;
  /** `track` plus its 128² and 64² copies; all three enabled only with a camera. */
  readonly tracks: FaceTracks;
  /** The camera track feeding the canvas, or null. The framer never stops it; its owner does. */
  readonly camera: MediaStreamTrack | null;
  /** What the three face senders should carry now: the camera for all three while the tab is hidden (the canvases
   * freeze), else `tracks`. */
  sendTracks(): FaceTracks;
  /** Set by the call; fired whenever `sendTracks()` may have changed. */
  onSendTrackChange: (() => void) | null;
  /** Swaps the camera behind the canvas (lobby spec §4.2); null stops drawing. */
  setCamera(raw: MediaStreamTrack | null): void;
}

export interface FramerOptions {
  /** A visibility:hidden box of its own (#local-media), never the remote #media box. */
  container: HTMLElement;
  document: Document;
  loadDetector?: () => Promise<Detector | null>;
  memory?: FramingMemory;
}

export function createFramer(opts: FramerOptions): Framer {
  const { document: doc } = opts;
  const video = doc.createElement('video') as FrameVideo;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  opts.container.append(video);
  let camera: MediaStreamTrack | null = null;

  const face256 = createFaceCanvas(doc, OUTPUT_SIZE, OUTPUT_FPS);
  const face128 = createFaceCanvas(doc, 128, OUTPUT_FPS);
  const face64 = createFaceCanvas(doc, 64, FACE_64_FPS);
  const { canvas, track } = face256;
  const tracks: FaceTracks = { 256: track, 128: face128.track, 64: face64.track };
  const setEnabled = (on: boolean) => {
    track.enabled = on;
    face128.track.enabled = on;
    face64.track.enabled = on;
  };
  setEnabled(false);
  const frameStep = createFrameStep((v, r) => {
    face256.ctx.drawImage(v, r.x, r.y, r.size, r.size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    face128.ctx.drawImage(canvas, 0, 0, 128, 128);
    face64.ctx.drawImage(canvas, 0, 0, 64, 64);
  }, opts.memory);
  stepEveryFrame(video, frameStep);

  void (opts.loadDetector ?? loadFaceDetector)().then((d) => frameStep.setDetector(d));

  const framer: Framer = {
    track,
    canvas,
    get camera() {
      return camera;
    },
    tracks,
    sendTracks() {
      return doc.visibilityState === 'hidden' && camera ? { 256: camera, 128: camera, 64: camera } : tracks;
    },
    onSendTrackChange: null,
    setCamera(raw) {
      camera = raw;
      frameStep.setCamera(raw ? (raw.getSettings().deviceId ?? '') : null);
      video.srcObject = raw ? new MediaStream([raw]) : null;
      if (raw) {
        void video.play().catch(() => {});
      }
      setEnabled(raw !== null);
      framer.onSendTrackChange?.();
    },
  };
  doc.addEventListener('visibilitychange', () => framer.onSendTrackChange?.());
  return framer;
}

/** A size² canvas whose captured track (at `fps`) is one of the faces we send. */
function createFaceCanvas(doc: Document, size: number, fps: number) {
  const canvas = doc.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const track = canvas.captureStream(fps).getVideoTracks().at(0);
  if (!ctx || !track) {
    throw new Error('a canvas without a 2d context or a captured track');
  }
  return { canvas, ctx, track };
}

function stepEveryFrame(video: FrameVideo, frameStep: FrameStep): void {
  if (video.requestVideoFrameCallback) {
    const onFrame = (now: number) => {
      frameStep.step(video, now);
      video.requestVideoFrameCallback?.(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } else {
    setInterval(() => frameStep.step(video, performance.now()), VIDEO_POLL_MS);
  }
}
