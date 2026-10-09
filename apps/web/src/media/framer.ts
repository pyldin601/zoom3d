// Face framing glue (face-framing spec §5): plays the raw camera in a hidden <video>, detects the face once a
// second, and draws a smoothed square crop into a 256² canvas whose captureStream is what peers get.
import { type Detector, loadFaceDetector } from './face-detector';
import { type Box, createFraming, type Framing, type Rect } from './framing';

export const OUTPUT_SIZE = 256;
export const OUTPUT_FPS = 24;
export const DETECT_MS = 1000;

export interface FrameStep {
  setDetector(d: Detector | null): void;
  step(video: HTMLVideoElement, now: number): void;
}

/** One camera frame: maybe detect, update the framing, draw. */
export function createFrameStep(draw: (video: HTMLVideoElement, rect: Rect) => void): FrameStep {
  let detector: Detector | null = null;
  let framing: Framing | null = null;
  let frameW = 0;
  let frameH = 0;
  let lastDetectAt = Number.NEGATIVE_INFINITY;

  return {
    setDetector(d) {
      detector = d;
    },
    step(video, now) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w === 0 || h === 0) {
        return;
      }
      if (!framing || w !== frameW || h !== frameH) {
        framing = createFraming(w, h);
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
          console.warn('face detection failed; framing stays centred', err);
          detector = null;
        }
      }
      draw(video, framing.update(box, now));
    },
  };
}

export interface Framer {
  /** The framed OUTPUT_SIZE² canvas track. */
  readonly track: MediaStreamTrack;
  /** The camera track. */
  readonly rawTrack: MediaStreamTrack;
  /** What senders should carry now: the raw track while the tab is hidden (the canvas freezes), else `track`. */
  readonly sendTrack: MediaStreamTrack;
  /** Set by the call; fired whenever `sendTrack` may have changed. */
  onSendTrackChange: (() => void) | null;
  setEnabled(on: boolean): void;
}

export interface FramerOptions {
  rawTrack: MediaStreamTrack;
  /** A visibility:hidden box of its own (#local-media), never the remote #media box. */
  container: HTMLElement;
  document: Document;
  loadDetector?: () => Promise<Detector | null>;
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
};

/** Fallback polling when requestVideoFrameCallback is missing: one 24 fps frame. */
const POLL_MS = 42;

export function createFramer(opts: FramerOptions): Framer {
  const { rawTrack, document: doc } = opts;
  const video = doc.createElement('video') as FrameVideo;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = new MediaStream([rawTrack]);
  opts.container.append(video);
  void video.play().catch(() => {});

  const canvas = doc.createElement('canvas');
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const track = canvas.captureStream(OUTPUT_FPS).getVideoTracks()[0] as MediaStreamTrack;
  const frameStep = createFrameStep((v, r) => {
    ctx.drawImage(v, r.x, r.y, r.size, r.size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  });
  let enabled = true;

  if (video.requestVideoFrameCallback) {
    const onFrame = (now: number) => {
      if (enabled) {
        frameStep.step(video, now);
      }
      video.requestVideoFrameCallback?.(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } else {
    setInterval(() => {
      if (enabled) {
        frameStep.step(video, performance.now());
      }
    }, POLL_MS);
  }

  void (opts.loadDetector ?? loadFaceDetector)().then((d) => frameStep.setDetector(d));

  const framer: Framer = {
    track,
    rawTrack,
    get sendTrack() {
      return doc.visibilityState === 'hidden' ? rawTrack : track;
    },
    onSendTrackChange: null,
    setEnabled(on) {
      enabled = on;
      rawTrack.enabled = on;
      track.enabled = on;
    },
  };
  doc.addEventListener('visibilitychange', () => framer.onSendTrackChange?.());
  return framer;
}
