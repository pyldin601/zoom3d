// Local camera and mic from the lobby onward (lobby spec §3–4.1). Each device is requested on its own, so a
// blocked camera never costs the mic. The framer's canvas track is the stream's video for the whole visit;
// turning the camera off stops the camera behind it, and on restarts it, so peers never renegotiate.
import { type Device, type DeviceProblem, deviceProblem, listDevices } from './devices';
import type { Framer } from './framer';
import type { MediaPrefs } from './media-prefs';

// Wider than the 256² we send: the framer crops a square around the face (face-framing spec §6).
export const VIDEO_CONSTRAINTS: MediaTrackConstraints = { width: 640, height: 480, frameRate: 24 };

export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface MediaState {
  /** The camera is live. */
  cam: boolean;
  /** The mic is present and unmuted. */
  mic: boolean;
  /** False only for insecure, blocked or missing devices; a busy one can be retried. */
  camAvailable: boolean;
  micAvailable: boolean;
  camProblem: DeviceProblem | null;
  micProblem: DeviceProblem | null;
  /** Some getUserMedia request is in flight. */
  pending: boolean;
}

export interface LocalMediaEnv {
  isSecureContext: boolean;
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  onDeviceChange(cb: () => void): void;
  framer: Framer;
  createStream?(tracks: MediaStreamTrack[]): MediaStream;
}

export interface LocalMediaController {
  /** The framer's canvas track plus the mic track once there is one. */
  readonly stream: MediaStream;
  readonly framer: Framer;
  /** The first requests have settled. */
  readonly ready: Promise<void>;
  state(): MediaState;
  /** What the user asked for; only the four setters below change it. */
  prefs(): MediaPrefs;
  setCam(on: boolean): Promise<void>;
  setMic(on: boolean): void;
  useCamera(deviceId: string): Promise<void>;
  useMic(deviceId: string): Promise<void>;
  devices(): Promise<{ cams: Device[]; mics: Device[] }>;
  micTrack(): MediaStreamTrack | null;
  /** Called when state, prefs or the device list change; returns an unsubscribe. */
  subscribe(fn: () => void): () => void;
}

type Kind = 'cam' | 'mic';

export function createLocalMedia(env: LocalMediaEnv, initial: MediaPrefs): LocalMediaController {
  const prefs: MediaPrefs = { ...initial };
  const { framer } = env;
  const stream = (env.createStream ?? ((tracks) => new MediaStream(tracks)))([framer.track]);
  const available: Record<Kind, boolean> = { cam: true, mic: true };
  const problem: Record<Kind, DeviceProblem | null> = { cam: null, mic: null };
  // A request's result is used only if no newer request or stop came after it.
  const seq: Record<Kind, number> = { cam: 0, mic: 0 };
  // The latest mic request that came back; equal to seq.mic when none is in flight.
  let micSettled = 0;
  let camera: MediaStreamTrack | null = null;
  let mic: MediaStreamTrack | null = null;
  let inFlight = 0;
  const subscribers = new Set<() => void>();
  const notify = () => {
    for (const fn of [...subscribers]) {
      fn();
    }
  };

  // `exact`, not `ideal`: Chrome ignores an ideal deviceId and hands back the default device.
  const constraints = (base: MediaTrackConstraints, id: string | null): MediaTrackConstraints =>
    id ? { ...base, deviceId: { exact: id } } : { ...base };

  async function open(kind: Kind, id: string | null): Promise<MediaStreamTrack> {
    const s = await env.getUserMedia(
      kind === 'cam' ? { video: constraints(VIDEO_CONSTRAINTS, id) } : { audio: constraints(AUDIO_CONSTRAINTS, id) }
    );
    const track = (kind === 'cam' ? s.getVideoTracks() : s.getAudioTracks())[0];
    if (!track) {
      throw new DOMException('no track', 'NotFoundError');
    }
    return track;
  }

  async function request(kind: Kind, id: string | null): Promise<MediaStreamTrack> {
    inFlight++;
    notify();
    try {
      try {
        return await open(kind, id);
      } catch (err) {
        // The chosen device is gone (unplugged since it was saved): use the default instead.
        if (id === null || deviceProblem(err) !== 'missing') {
          throw err;
        }
        return await open(kind, null);
      }
    } finally {
      inFlight--;
    }
  }

  function fail(kind: Kind, err: unknown) {
    problem[kind] = deviceProblem(err);
    available[kind] = problem[kind] === 'busy';
  }

  function succeed(kind: Kind) {
    problem[kind] = null;
    available[kind] = true;
  }

  async function openCamera(id: string | null): Promise<void> {
    const mine = ++seq.cam;
    try {
      const track = await request('cam', id);
      if (mine !== seq.cam) {
        track.stop();
        return;
      }
      const old = camera;
      camera = track;
      track.addEventListener('ended', () => {
        if (camera === track) {
          // Unplugged: come back on whatever the default is now.
          camera = null;
          framer.setCamera(null);
          void openCamera(null);
        }
      });
      framer.setCamera(track);
      old?.stop();
      succeed('cam');
    } catch (err) {
      if (mine === seq.cam) {
        fail('cam', err);
      }
    } finally {
      notify();
    }
  }

  function stopCamera() {
    seq.cam++;
    const old = camera;
    camera = null;
    framer.setCamera(null);
    old?.stop();
    notify();
  }

  async function openMic(id: string | null): Promise<void> {
    const mine = ++seq.mic;
    try {
      const track = await request('mic', id);
      if (mine !== seq.mic) {
        track.stop();
        return;
      }
      track.enabled = prefs.mic;
      const old = mic;
      if (old) {
        stream.removeTrack(old);
      }
      stream.addTrack(track);
      mic = track;
      track.addEventListener('ended', () => {
        if (mic === track) {
          stream.removeTrack(track);
          mic = null;
          void openMic(null);
        }
      });
      old?.stop();
      succeed('mic');
    } catch (err) {
      if (mine === seq.mic) {
        fail('mic', err);
      }
    } finally {
      if (mine === seq.mic) {
        micSettled = mine;
      }
      notify();
    }
  }

  let ready: Promise<void>;
  if (!env.isSecureContext) {
    for (const kind of ['cam', 'mic'] as const) {
      available[kind] = false;
      problem[kind] = 'insecure';
    }
    ready = Promise.resolve();
  } else {
    ready = Promise.all([prefs.cam ? openCamera(prefs.camId) : null, openMic(prefs.micId)]).then(() => {});
  }
  env.onDeviceChange(notify);

  return {
    stream,
    framer,
    ready,
    state: () => ({
      cam: camera !== null,
      mic: mic !== null && prefs.mic,
      camAvailable: available.cam,
      micAvailable: available.mic,
      camProblem: problem.cam,
      micProblem: problem.mic,
      pending: inFlight > 0,
    }),
    prefs: () => ({ ...prefs }),
    async setCam(on) {
      prefs.cam = on;
      if (!on) {
        stopCamera();
      } else if (env.isSecureContext && !camera) {
        await openCamera(prefs.camId);
      } else {
        notify();
      }
    },
    setMic(on) {
      prefs.mic = on;
      if (mic) {
        mic.enabled = on;
      } else if (on && available.mic && env.isSecureContext && seq.mic === micSettled) {
        // A busy mic gets another try; one already on its way is left alone.
        void openMic(prefs.micId);
      }
      notify();
    },
    async useCamera(deviceId) {
      prefs.camId = deviceId;
      if (prefs.cam && env.isSecureContext) {
        await openCamera(deviceId);
      } else {
        notify();
      }
    },
    async useMic(deviceId) {
      prefs.micId = deviceId;
      if (env.isSecureContext) {
        await openMic(deviceId);
      } else {
        notify();
      }
    },
    async devices() {
      try {
        const infos = await env.enumerateDevices();
        return { cams: listDevices(infos, 'videoinput'), mics: listDevices(infos, 'audioinput') };
      } catch {
        return { cams: [], mics: [] };
      }
    },
    micTrack: () => mic,
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
