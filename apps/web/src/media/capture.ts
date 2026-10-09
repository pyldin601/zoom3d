// Camera + microphone capture with graceful fallbacks. Must run inside a user gesture (Join click).
import type { Framer } from './framer';

// Wider than the 256² we send: the framer crops a square around the face (face-framing spec §6).
export const VIDEO_CONSTRAINTS: MediaTrackConstraints = { width: 640, height: 480, frameRate: 24 };

export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface LocalMedia {
  stream: MediaStream | null;
  cam: boolean;
  mic: boolean;
  problem: 'insecure' | 'no-camera' | 'no-mic' | 'none-available' | null;
  /** Frames the camera into the stream's video track; null without a camera. */
  framer: Framer | null;
}

export interface CaptureEnv {
  isSecureContext: boolean;
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  /** Wraps the raw camera track; when given, the stream carries the framed track instead. */
  frame?: (raw: MediaStreamTrack) => Framer;
  createStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}

const ATTEMPTS: { constraints: MediaStreamConstraints; problem: LocalMedia['problem'] }[] = [
  { constraints: { video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS }, problem: null },
  { constraints: { audio: AUDIO_CONSTRAINTS }, problem: 'no-camera' },
  { constraints: { video: VIDEO_CONSTRAINTS }, problem: 'no-mic' },
];

/** A framer that cannot start must not cost the camera: send the raw stream instead, as before framing. */
function tryFrame(frame: (raw: MediaStreamTrack) => Framer, raw: MediaStreamTrack): Framer | null {
  try {
    return frame(raw);
  } catch (err) {
    console.warn('face framing unavailable; sending the raw camera', err);
    return null;
  }
}

export async function captureLocalMedia(env: CaptureEnv): Promise<LocalMedia> {
  if (!env.isSecureContext) {
    return { stream: null, cam: false, mic: false, problem: 'insecure', framer: null };
  }
  for (const { constraints, problem } of ATTEMPTS) {
    try {
      const raw = await env.getUserMedia(constraints);
      const video = raw.getVideoTracks()[0];
      const framer = video && env.frame ? tryFrame(env.frame, video) : null;
      const createStream = env.createStream ?? ((tracks) => new MediaStream(tracks));
      return {
        stream: framer ? createStream([framer.track, ...raw.getAudioTracks()]) : raw,
        cam: video !== undefined,
        mic: raw.getAudioTracks().length > 0,
        problem,
        framer,
      };
    } catch {
      // Denied, missing device or busy: try the next, smaller request.
    }
  }
  return { stream: null, cam: false, mic: false, problem: 'none-available', framer: null };
}
