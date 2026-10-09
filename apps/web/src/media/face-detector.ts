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
type Detection = { boundingBox?: BoundingBox; keypoints?: { x: number; y: number }[] };
/** BlazeFace keypoints: right eye, left eye, nose tip, mouth centre, right ear, left ear. */
const MOUTH = 3;

/** The largest face, in source pixels, with its mouth when present (keypoints are normalized 0..1). */
export function largestBox(detections: Detection[], frameW: number, frameH: number): Box | null {
  let best: Detection | null = null;
  for (const d of detections) {
    const b = d.boundingBox;
    if (b && (!best?.boundingBox || b.width * b.height > best.boundingBox.width * best.boundingBox.height)) {
      best = d;
    }
  }
  const b = best?.boundingBox;
  if (!b) {
    return null;
  }
  const box: Box = { x: b.originX, y: b.originY, w: b.width, h: b.height };
  const mouth = best?.keypoints?.[MOUTH];
  if (mouth) {
    box.mouth = { x: mouth.x * frameW, y: mouth.y * frameH };
  }
  return box;
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
    return {
      detect: (video, now) =>
        largestBox(detector.detectForVideo(video, now).detections, video.videoWidth, video.videoHeight),
    };
  } catch (err) {
    console.warn('face detector unavailable', err);
    return null;
  }
}
