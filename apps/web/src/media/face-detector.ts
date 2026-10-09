// MediaPipe Face Detector (BlazeFace short range), self-hosted under /mediapipe/ (face-framing spec §4).
// Loaded lazily after Join; any failure means no detector, and the framer keeps the centred crop.
import type * as Vision from '@mediapipe/tasks-vision';
import type { Box } from './framing';

const WASM_BASE = '/mediapipe/wasm';
const MODEL_PATH = '/mediapipe/blaze_face_short_range.tflite';

export interface Detector {
  /** The largest face in the current frame, or null. */
  detect(video: HTMLVideoElement, now: number): Box | null;
}

type BoundingBox = { originX: number; originY: number; width: number; height: number };

export function largestBox(detections: { boundingBox?: BoundingBox }[]): Box | null {
  let best: BoundingBox | null = null;
  for (const { boundingBox: b } of detections) {
    if (b && (!best || b.width * b.height > best.width * best.height)) {
      best = b;
    }
  }
  return best ? { x: best.originX, y: best.originY, w: best.width, h: best.height } : null;
}

export async function loadFaceDetector(deps: { load?: () => Promise<typeof Vision> } = {}): Promise<Detector | null> {
  try {
    const { FilesetResolver, FaceDetector } = await (deps.load ?? (() => import('@mediapipe/tasks-vision')))();
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const create = (delegate: 'GPU' | 'CPU') =>
      FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate },
        runningMode: 'VIDEO',
      });
    let detector: Vision.FaceDetector;
    try {
      detector = await create('GPU');
    } catch {
      detector = await create('CPU');
    }
    return { detect: (video, now) => largestBox(detector.detectForVideo(video, now).detections) };
  } catch (err) {
    console.warn('face detector unavailable', err);
    return null;
  }
}
