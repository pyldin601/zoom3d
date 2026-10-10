import { beforeEach, expect, test, vi } from 'vitest';
import type { Framer } from './framer';
import { AUDIO_CONSTRAINTS, createLocalMedia, type LocalMediaEnv, VIDEO_CONSTRAINTS } from './local-media';
import { DEFAULT_MEDIA_PREFS, type MediaPrefs } from './media-prefs';

class FakeTrack {
  enabled = true;
  stopped = false;
  private onEnded: (() => void)[] = [];
  constructor(
    readonly kind: 'video' | 'audio',
    readonly id: string
  ) {}
  stop() {
    this.stopped = true;
  }
  addEventListener(type: string, fn: () => void) {
    if (type === 'ended') {
      this.onEnded.push(fn);
    }
  }
  end() {
    for (const fn of this.onEnded) {
      fn();
    }
  }
}

interface Request {
  constraints: MediaStreamConstraints;
  resolve(t: FakeTrack): void;
  reject(err: unknown): void;
}

let requests: Request[];
let framer: { track: FakeTrack; camera: MediaStreamTrack | null; setCamera: (raw: MediaStreamTrack | null) => void };
let deviceChange: (() => void) | null;
let env: LocalMediaEnv;
let ids: number;

const flush = () => new Promise((r) => setTimeout(r));
const lastRequest = () => requests.at(-1) as Request;
const videoRequests = () => requests.filter((r) => r.constraints.video);
const audioRequests = () => requests.filter((r) => r.constraints.audio);
const cam = () => new FakeTrack('video', `cam${++ids}`);
const mic = () => new FakeTrack('audio', `mic${++ids}`);
const make = (prefs: Partial<MediaPrefs> = {}) => createLocalMedia(env, { ...DEFAULT_MEDIA_PREFS, ...prefs });

beforeEach(() => {
  requests = [];
  ids = 0;
  deviceChange = null;
  framer = {
    track: new FakeTrack('video', 'canvas'),
    camera: null,
    setCamera(raw) {
      framer.camera = raw;
    },
  };
  env = {
    isSecureContext: true,
    getUserMedia: (constraints) =>
      new Promise((resolve, reject) => {
        requests.push({
          constraints,
          resolve: (t) =>
            resolve({
              getVideoTracks: () => (t.kind === 'video' ? [t] : []),
              getAudioTracks: () => (t.kind === 'audio' ? [t] : []),
            } as unknown as MediaStream),
          reject,
        });
      }),
    enumerateDevices: async () => [
      { kind: 'videoinput', deviceId: 'c1', label: 'FaceTime HD' } as MediaDeviceInfo,
      { kind: 'audioinput', deviceId: 'm1', label: '' } as MediaDeviceInfo,
    ],
    onDeviceChange: (cb) => {
      deviceChange = cb;
    },
    framer: framer as unknown as Framer,
    createStream: (tracks) => {
      const list = [...tracks];
      return {
        list,
        getVideoTracks: () => list.filter((t) => t.kind === 'video'),
        getAudioTracks: () => list.filter((t) => t.kind === 'audio'),
        addTrack: (t: MediaStreamTrack) => list.push(t),
        removeTrack: (t: MediaStreamTrack) => list.splice(list.indexOf(t), 1),
      } as unknown as MediaStream;
    },
  };
});

/** Grants the first pending camera and mic requests. */
async function grantStart() {
  const c = cam();
  const m = mic();
  videoRequests()[0]?.resolve(c);
  audioRequests()[0]?.resolve(m);
  await flush();
  return { c, m };
}

test('constraints match the spec', () => {
  expect(VIDEO_CONSTRAINTS).toEqual({ width: 640, height: 480, frameRate: 24 });
  expect(AUDIO_CONSTRAINTS).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
});

test('requests camera and mic separately with saved ids as exact', () => {
  make({ camId: 'c1', micId: 'm1' });
  expect(requests.map((r) => r.constraints)).toEqual([
    { video: { ...VIDEO_CONSTRAINTS, deviceId: { exact: 'c1' } } },
    { audio: { ...AUDIO_CONSTRAINTS, deviceId: { exact: 'm1' } } },
  ]);
});

test('a saved device that is gone falls back to the default', async () => {
  const local = make({ camId: 'gone', cam: true });
  videoRequests()[0]?.reject(new DOMException('no such device', 'OverconstrainedError'));
  await flush();
  expect(videoRequests().map((r) => r.constraints)).toEqual([
    { video: { ...VIDEO_CONSTRAINTS, deviceId: { exact: 'gone' } } },
    { video: { ...VIDEO_CONSTRAINTS, facingMode: { ideal: 'user' } } },
  ]);
  const c = cam();
  videoRequests()[1]?.resolve(c);
  audioRequests()[0]?.resolve(mic());
  await local.ready;
  expect(framer.camera).toBe(c);
  expect(local.state()).toMatchObject({ cam: true, camProblem: null });
});

test('a blocked device is not retried without its id', async () => {
  const local = make({ camId: 'c1' });
  videoRequests()[0]?.reject(new DOMException('no', 'NotAllowedError'));
  audioRequests()[0]?.resolve(mic());
  await local.ready;
  expect(videoRequests()).toHaveLength(1);
  expect(local.state().camProblem).toBe('blocked');
});

test('without saved ids the camera prefers the front camera and the mic has no deviceId', () => {
  make();
  expect(requests.map((r) => r.constraints)).toEqual([
    { video: { ...VIDEO_CONSTRAINTS, facingMode: { ideal: 'user' } } },
    { audio: AUDIO_CONSTRAINTS },
  ]);
});

test('the stream carries the canvas track, then the mic once granted', async () => {
  const local = make();
  expect(local.stream.getVideoTracks()).toEqual([framer.track]);
  const { c, m } = await grantStart();
  expect(local.stream.getVideoTracks()).toEqual([framer.track]);
  expect(local.stream.getAudioTracks()).toEqual([m]);
  expect(framer.camera).toBe(c);
  expect(local.micTrack()).toBe(m);
  expect(local.state()).toMatchObject({ cam: true, mic: true, camAvailable: true, micAvailable: true });
});

test('a camera saved as off is never requested; a muted mic is opened but disabled', async () => {
  const local = make({ cam: false, mic: false });
  expect(videoRequests()).toHaveLength(0);
  const m = mic();
  lastRequest().resolve(m);
  await flush();
  expect(m.enabled).toBe(false);
  expect(local.state()).toMatchObject({ cam: false, mic: false, micAvailable: true });
});

test('a blocked camera keeps the mic', async () => {
  const local = make();
  videoRequests()[0]?.reject(new DOMException('no', 'NotAllowedError'));
  audioRequests()[0]?.resolve(mic());
  await local.ready;
  expect(local.state()).toMatchObject({
    cam: false,
    camAvailable: false,
    camProblem: 'blocked',
    mic: true,
    micAvailable: true,
    micProblem: null,
  });
});

test('insecure context requests nothing', async () => {
  env.isSecureContext = false;
  const local = make();
  await local.ready;
  expect(requests).toHaveLength(0);
  expect(local.state()).toMatchObject({
    camAvailable: false,
    micAvailable: false,
    camProblem: 'insecure',
    micProblem: 'insecure',
  });
});

test('setCam(false) stops the camera and clears the framer; setCam(true) reopens the chosen device', async () => {
  const local = make({ camId: 'c1' });
  const { c } = await grantStart();
  await local.setCam(false);
  expect(c.stopped).toBe(true);
  expect(framer.camera).toBeNull();
  expect(local.state().cam).toBe(false);
  expect(local.prefs().cam).toBe(false);
  const on = local.setCam(true);
  expect(lastRequest().constraints).toEqual({ video: { ...VIDEO_CONSTRAINTS, deviceId: { exact: 'c1' } } });
  const c2 = cam();
  lastRequest().resolve(c2);
  await on;
  expect(framer.camera).toBe(c2);
  expect(local.state().cam).toBe(true);
});

test('latest toggle wins: a camera that arrives after being turned off is stopped at once', async () => {
  const local = make({ cam: false });
  const on = local.setCam(true);
  await local.setCam(false);
  const late = cam();
  videoRequests()[0]?.resolve(late);
  await on;
  expect(late.stopped).toBe(true);
  expect(framer.camera).toBeNull();
  expect(local.state().cam).toBe(false);
});

test('useCamera while on swaps before stopping the old one', async () => {
  const local = make();
  const { c } = await grantStart();
  const order: string[] = [];
  const setCamera = framer.setCamera;
  framer.setCamera = (raw) => {
    order.push(`set ${raw ? (raw as unknown as FakeTrack).id : 'null'}`);
    setCamera(raw);
  };
  const stop = c.stop.bind(c);
  c.stop = () => {
    order.push(`stop ${c.id}`);
    stop();
  };
  const done = local.useCamera('c2');
  expect(lastRequest().constraints).toEqual({ video: { ...VIDEO_CONSTRAINTS, deviceId: { exact: 'c2' } } });
  const c2 = cam();
  lastRequest().resolve(c2);
  await done;
  expect(order).toEqual([`set ${c2.id}`, `stop ${c.id}`]);
  expect(local.prefs().camId).toBe('c2');
});

test('useCamera while off only records the choice', async () => {
  const local = make({ cam: false });
  await local.useCamera('c2');
  expect(videoRequests()).toHaveLength(0);
  expect(local.prefs().camId).toBe('c2');
});

test("useMic replaces the stream's audio track and keeps a muted mic muted", async () => {
  const local = make();
  const { m } = await grantStart();
  local.setMic(false);
  expect(m.enabled).toBe(false);
  const done = local.useMic('m2');
  expect(lastRequest().constraints).toEqual({ audio: { ...AUDIO_CONSTRAINTS, deviceId: { exact: 'm2' } } });
  const m2 = mic();
  lastRequest().resolve(m2);
  await done;
  expect(local.stream.getAudioTracks()).toEqual([m2]);
  expect(m.stopped).toBe(true);
  expect(m2.enabled).toBe(false);
  expect(local.state().mic).toBe(false);
  expect(local.prefs()).toMatchObject({ mic: false, micId: 'm2' });
});

test('a busy camera stays available and can be retried', async () => {
  const local = make();
  videoRequests()[0]?.reject(new DOMException('in use', 'NotReadableError'));
  audioRequests()[0]?.resolve(mic());
  await local.ready;
  expect(local.state()).toMatchObject({ cam: false, camAvailable: true, camProblem: 'busy' });
  const on = local.setCam(true);
  lastRequest().resolve(cam());
  await on;
  expect(local.state()).toMatchObject({ cam: true, camProblem: null });
});

test('a busy mic is retried when it is turned on', async () => {
  const local = make();
  videoRequests()[0]?.resolve(cam());
  audioRequests()[0]?.reject(new DOMException('in use', 'NotReadableError'));
  await local.ready;
  expect(local.state()).toMatchObject({ mic: false, micAvailable: true, micProblem: 'busy' });
  local.setMic(false);
  local.setMic(true);
  expect(audioRequests()).toHaveLength(2);
  const m = mic();
  lastRequest().resolve(m);
  await flush();
  expect(local.state()).toMatchObject({ mic: true, micProblem: null });
  expect(local.stream.getAudioTracks()).toEqual([m]);
});

test('an ended camera track restarts on the default device', async () => {
  make({ camId: 'c1' });
  const { c } = await grantStart();
  c.end();
  expect(framer.camera).toBeNull();
  expect(lastRequest().constraints).toEqual({ video: { ...VIDEO_CONSTRAINTS, facingMode: { ideal: 'user' } } });
  const c2 = cam();
  lastRequest().resolve(c2);
  await flush();
  expect(framer.camera).toBe(c2);
});

test('an ended mic track restarts on the default device', async () => {
  const local = make({ micId: 'm1' });
  const { m } = await grantStart();
  m.end();
  expect(local.stream.getAudioTracks()).toEqual([]);
  expect(lastRequest().constraints).toEqual({ audio: AUDIO_CONSTRAINTS });
  const m2 = mic();
  lastRequest().resolve(m2);
  await flush();
  expect(local.stream.getAudioTracks()).toEqual([m2]);
});

test('pending is true while a request is in flight', async () => {
  const local = make();
  expect(local.state().pending).toBe(true);
  await grantStart();
  expect(local.state().pending).toBe(false);
  void local.setCam(false);
  const on = local.setCam(true);
  expect(local.state().pending).toBe(true);
  lastRequest().resolve(cam());
  await on;
  expect(local.state().pending).toBe(false);
});

test('subscribers hear changes and device changes, and can unsubscribe', async () => {
  const local = make();
  const heard = vi.fn();
  const off = local.subscribe(heard);
  await grantStart();
  expect(heard).toHaveBeenCalled();
  heard.mockClear();
  local.setMic(false);
  expect(heard).toHaveBeenCalledTimes(1);
  deviceChange?.();
  expect(heard).toHaveBeenCalledTimes(2);
  off();
  local.setMic(true);
  expect(heard).toHaveBeenCalledTimes(2);
});

test('devices lists cameras and microphones', async () => {
  const local = make();
  expect(await local.devices()).toEqual({
    cams: [{ id: 'c1', label: 'FaceTime HD' }],
    mics: [{ id: 'm1', label: 'Microphone 1' }],
  });
});

test('prefs() keeps the intent when the device fails', async () => {
  const local = make();
  videoRequests()[0]?.reject(new DOMException('no', 'NotAllowedError'));
  audioRequests()[0]?.resolve(mic());
  await local.ready;
  expect(local.prefs().cam).toBe(true);
  expect(local.state().cam).toBe(false);
});
