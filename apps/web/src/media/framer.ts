// Face framing glue (face-framing spec §5): plays the raw camera in a hidden <video>, detects the face once a
// second, and draws a smoothed square crop into a 256² canvas whose captureStream is what peers get.
import { type Detector, loadFaceDetector } from './face-detector';
import { type Box, createFraming, type Framing, type Rect } from './framing';
import type { FramingMemory } from './framing-memory';

export const OUTPUT_SIZE = 256;
export const OUTPUT_FPS = 24;
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
      if (!framing || w !== frameW || h !== frameH) {
        framing = createFraming(w, h, camera === null ? null : (memory?.load(camera, w, h) ?? null));
        frameW = w;
        frameH = h;
      }
      let box: Box | null = null;
      if (detector && now - lastDetectAt >= DETECT_MS) {
        lastDetectAt = now;
        try {
          box = detector.detect(video, now);
        } catch (err) {
          // Never retried: the crop eases back to centre once LOST_MS passes.
          console.warn('face detection failed; framing falls back to the centre', err);
          detector = null;
        }
      }
      const rect = framing.update(box, now, searching);
      if (box && camera !== null) {
        memory?.save(camera, w, h, framing.target);
      }
      draw(video, rect);
    },
  };
}

export interface Framer {
  /** The framed OUTPUT_SIZE² canvas track; exists with or without a camera, disabled without one. */
  readonly track: MediaStreamTrack;
  /** The camera track feeding the canvas, or null. The framer never stops it; its owner does. */
  readonly camera: MediaStreamTrack | null;
  /** What senders should carry now: the camera while the tab is hidden (the canvas freezes), else `track`. */
  readonly sendTrack: MediaStreamTrack;
  /** Set by the call; fired whenever `sendTrack` may have changed. */
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

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
};

/** Fallback polling when requestVideoFrameCallback is missing: one 24 fps frame. */
const POLL_MS = 42;

export function createFramer(opts: FramerOptions): Framer {
  const { document: doc } = opts;
  const video = doc.createElement('video') as FrameVideo;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  opts.container.append(video);
  let camera: MediaStreamTrack | null = null;

  const canvas = doc.createElement('canvas');
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const track = canvas.captureStream(OUTPUT_FPS).getVideoTracks()[0] as MediaStreamTrack;
  track.enabled = false;
  const frameStep = createFrameStep((v, r) => {
    ctx.drawImage(v, r.x, r.y, r.size, r.size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  }, opts.memory);

  if (video.requestVideoFrameCallback) {
    const onFrame = (now: number) => {
      frameStep.step(video, now);
      video.requestVideoFrameCallback?.(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } else {
    setInterval(() => frameStep.step(video, performance.now()), POLL_MS);
  }

  void (opts.loadDetector ?? loadFaceDetector)().then((d) => frameStep.setDetector(d));

  const framer: Framer = {
    track,
    get camera() {
      return camera;
    },
    get sendTrack() {
      return doc.visibilityState === 'hidden' && camera ? camera : track;
    },
    onSendTrackChange: null,
    setCamera(raw) {
      camera = raw;
      frameStep.setCamera(raw ? (raw.getSettings().deviceId ?? '') : null);
      video.srcObject = raw ? new MediaStream([raw]) : null;
      if (raw) {
        void video.play().catch(() => {});
      }
      track.enabled = raw !== null;
      framer.onSendTrackChange?.();
    },
  };
  doc.addEventListener('visibilitychange', () => framer.onSendTrackChange?.());
  return framer;
}
