// Camera + microphone capture with graceful fallbacks. Must run inside a user gesture (Join click).

export const VIDEO_CONSTRAINTS = {
  width: 160,
  height: 160,
  aspectRatio: 1,
  frameRate: 15,
  resizeMode: 'crop-and-scale',
} as MediaTrackConstraints;

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
}

export interface CaptureEnv {
  isSecureContext: boolean;
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
}

const ATTEMPTS: { constraints: MediaStreamConstraints; problem: LocalMedia['problem'] }[] = [
  { constraints: { video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS }, problem: null },
  { constraints: { audio: AUDIO_CONSTRAINTS }, problem: 'no-camera' },
  { constraints: { video: VIDEO_CONSTRAINTS }, problem: 'no-mic' },
];

export async function captureLocalMedia(env: CaptureEnv): Promise<LocalMedia> {
  if (!env.isSecureContext) return { stream: null, cam: false, mic: false, problem: 'insecure' };
  for (const { constraints, problem } of ATTEMPTS) {
    try {
      const stream = await env.getUserMedia(constraints);
      return {
        stream,
        cam: stream.getVideoTracks().length > 0,
        mic: stream.getAudioTracks().length > 0,
        problem,
      };
    } catch {
      // Denied, missing device or busy: try the next, smaller request.
    }
  }
  return { stream: null, cam: false, mic: false, problem: 'none-available' };
}
