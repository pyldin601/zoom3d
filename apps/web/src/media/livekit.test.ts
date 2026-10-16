import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BOOMBOX_MAX_BITRATE,
  createLiveKitTransport,
  FACE_64_MAX_BITRATE,
  FACE_128_MAX_BITRATE,
  type LiveKitTransportOptions,
  VIDEO_MAX_BITRATE,
} from './livekit';
import type { FaceTracks } from './transport';

type Track = { kind: string; id: string; enabled: boolean; stopped?: boolean; size?: [number, number] };
const track = (kind: string, id: string, enabled = true, size?: [number, number]): Track => ({
  kind,
  id,
  enabled,
  size,
});
const asTrack = (t: Track) => t as unknown as MediaStreamTrack;
// getSettings() reports the track's size, as Chrome does for cameras and canvases.
const sized = (t: Track) =>
  Object.assign(t, { getSettings: () => (t.size ? { width: t.size[0], height: t.size[1] } : {}) });
const faceTracks = (a: Track, b: Track, c: Track) => ({ 256: a, 128: b, 64: c }) as unknown as FaceTracks;

/** RTCRtpSender as far as the hidden-tab scaling uses it. */
class FakeSender {
  encodings: RTCRtpEncodingParameters[] = [{ maxBitrate: 1 }];
  getParameters() {
    return { encodings: this.encodings.map((e) => ({ ...e })) } as RTCRtpSendParameters;
  }
  setParameters = vi.fn(async (p: RTCRtpSendParameters) => {
    this.encodings = p.encodings;
  });
}

/**
 * livekit-client's LocalTrack as far as this transport meets it (read from livekit-client 2.22 src):
 * - setMediaStreamTrack rewrites `enabled` to `!isMuted` (on publish and on every replaceTrack);
 * - an ended track gets mute()d;
 * - stop() stops the underlying track.
 */
class FakeLocalTrack {
  isMuted = false;
  sender = new FakeSender();
  constructor(public mediaStreamTrack: Track) {
    mediaStreamTrack.enabled = !this.isMuted;
  }
  replaceTrack = vi.fn(async (next: Track, _opts?: unknown) => {
    this.mediaStreamTrack = next;
    next.enabled = !this.isMuted;
    return this;
  });
  async mute() {
    this.isMuted = true;
    this.mediaStreamTrack.enabled = false;
  }
  unmute = vi.fn(async () => {
    this.isMuted = false;
    this.mediaStreamTrack.enabled = true;
  });
  stop() {
    this.mediaStreamTrack.stopped = true;
  }
}

/** A remote participant's publication; subscribing is up to us (autoSubscribe off). */
class FakeRemotePub {
  subscribed = false;
  remoteTrack: { mediaStreamTrack: Track; getRTCStatsReport: () => Promise<Map<string, unknown>> } | null = null;
  constructor(
    readonly room: FakeRoom,
    readonly identity: string,
    readonly trackName: string
  ) {}
  setSubscribed = vi.fn((on: boolean) => {
    if (!on && this.subscribed && this.remoteTrack) {
      const t = this.remoteTrack;
      this.subscribed = false;
      this.remoteTrack = null;
      this.room.emit('trackUnsubscribed', t, this, { identity: this.identity });
    }
    this.subscribed = on;
  });
  /** What we asked for last (ignoring repeats). */
  get wanted() {
    return this.setSubscribed.mock.calls.at(-1)?.[0] ?? false;
  }
}

class FakeRoom {
  static instances: FakeRoom[] = [];
  static failConnects = 0;
  /** Runs inside connect(): who is already in the room. */
  static onConnect: ((room: FakeRoom) => void) | null = null;
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  connectArgs: unknown[] = [];
  disconnectArgs: unknown[] | null = null;
  publications: { trackName: string; track?: FakeLocalTrack }[] = [];
  remoteParticipants = new Map<string, { identity: string; trackPublications: Map<string, FakeRemotePub> }>();
  localParticipant = {
    publishTrack: vi.fn(async (t: Track, opts: { name: string }) => {
      const pub = { trackName: opts.name, track: new FakeLocalTrack(t) };
      this.publications.push(pub);
      return pub;
    }),
    unpublishTrack: vi.fn(async (t: FakeLocalTrack | Track, stop = true) => {
      const pub = this.publications.find((p) => p.track === t || p.track?.mediaStreamTrack === t);
      this.publications = this.publications.filter((p) => p !== pub);
      if (stop) {
        pub?.track?.stop();
      }
    }),
  };
  constructor(public options: { stopLocalTrackOnUnpublish?: boolean; dynacast?: boolean }) {
    FakeRoom.instances.push(this);
  }
  async connect(...args: unknown[]) {
    this.connectArgs = args;
    FakeRoom.onConnect?.(this);
    if (FakeRoom.failConnects > 0) {
      FakeRoom.failConnects--;
      throw new Error('connect failed');
    }
  }
  async disconnect(...args: unknown[]) {
    this.disconnectArgs = args;
    if (args[0] !== false) {
      this.stopAll();
    }
  }
  on(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) {
      fn(...args);
    }
  }
  private stopAll() {
    for (const p of this.publications) {
      p.track?.stop();
    }
  }
  /** LiveKit giving up: Room.handleDisconnect(options.stopLocalTrackOnUnpublish), then Disconnected. */
  lose() {
    if (this.options.stopLocalTrackOnUnpublish !== false) {
      this.stopAll();
    }
    this.emit('disconnected');
  }
  /** A signal restart: republishAllTracks makes new publications for the same LocalTracks. */
  republish() {
    this.publications = this.publications.map((old) => {
      const fresh = { trackName: old.trackName, track: old.track };
      old.track = undefined;
      return fresh;
    });
  }
  localTrack(name: string) {
    return this.publications.find((p) => p.trackName === name)?.track;
  }
  /** A remote participant publishing tracks (before we connect: present in remoteParticipants, no event). */
  publishRemote(identity: string, names: string[], { silently = false } = {}) {
    let p = this.remoteParticipants.get(identity);
    if (!p) {
      p = { identity, trackPublications: new Map() };
      this.remoteParticipants.set(identity, p);
    }
    for (const name of names) {
      const pub = new FakeRemotePub(this, identity, name);
      p.trackPublications.set(`${identity}-${name}`, pub);
      if (!silently) {
        this.emit('trackPublished', pub, p);
      }
    }
  }
  pub(identity: string, name: string) {
    return this.remoteParticipants.get(identity)?.trackPublications.get(`${identity}-${name}`) as FakeRemotePub;
  }
  /** LiveKit delivering a track we subscribed to. */
  deliver(identity: string, trackName: string, t: Track, bytes = 0) {
    const pub = this.pub(identity, trackName);
    const remoteTrack = {
      mediaStreamTrack: t,
      getRTCStatsReport: async () => new Map([['x', { type: 'inbound-rtp', bytesReceived: bytes }]]),
    };
    pub.subscribed = true;
    pub.remoteTrack = remoteTrack;
    this.emit('trackSubscribed', remoteTrack, pub, { identity });
    return remoteTrack;
  }
  /** Names of `identity`'s publications we currently ask for. */
  asked(identity: string) {
    return [...(this.remoteParticipants.get(identity)?.trackPublications.values() ?? [])]
      .filter((p) => p.wanted)
      .map((p) => p.trackName);
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);
let remote: { peerId: string; tracks: Track[] }[];
let voices: { peerId: string; tracks: Track[] }[];
let boomboxes: { peerId: string; tracks: Track[] }[];
let camera: Track;
let mic: Track;

beforeEach(() => {
  vi.useFakeTimers();
  FakeRoom.instances = [];
  FakeRoom.failConnects = 0;
  FakeRoom.onConnect = null;
  remote = [];
  voices = [];
  boomboxes = [];
  camera = track('video', 'camera');
  mic = track('audio', 'mic');
});
afterEach(() => vi.useRealTimers());

function transport(over: Partial<LiveKitTransportOptions> = {}) {
  return createLiveKitTransport({
    url: 'ws://lk',
    token: 'tok',
    localStream: { getVideoTracks: () => [camera], getAudioTracks: () => [mic] } as unknown as MediaStream,
    onRemoteStream: (peerId, s) => remote.push({ peerId, tracks: (s as unknown as { tracks: Track[] }).tracks }),
    onRemoteVoice: (peerId, s) => voices.push({ peerId, tracks: (s as unknown as { tracks: Track[] }).tracks }),
    onRemoteBoombox: (peerId, s) => boomboxes.push({ peerId, tracks: (s as unknown as { tracks: Track[] }).tracks }),
    createStream: (tracks) => ({ tracks }) as unknown as MediaStream,
    loadRoom: async () => FakeRoom as unknown as NonNullable<LiveKitTransportOptions['RoomImpl']>,
    ...over,
  });
}
const room = (i = 0) => FakeRoom.instances[i] as FakeRoom;
const publishCalls = (i = 0) => room(i).localParticipant.publishTrack.mock.calls.map(([t, o]) => ({ t, o }));

describe('connecting and publishing', () => {
  test('connects with the token; subscribes itself; pauses unwanted sizes; never lets LiveKit stop our tracks', async () => {
    transport();
    await flush();
    expect(room().options).toEqual({ adaptiveStream: false, dynacast: true, stopLocalTrackOnUnpublish: false });
    expect(room().connectArgs).toEqual(['ws://lk', 'tok', { autoSubscribe: false }]);
  });

  test('publishes the face then the mic, by name, with their encodings', async () => {
    transport();
    await flush();
    expect(publishCalls()).toEqual([
      {
        t: camera,
        o: {
          name: 'face',
          source: 'camera',
          simulcast: false,
          videoEncoding: { maxBitrate: VIDEO_MAX_BITRATE, maxFramerate: 24 },
        },
      },
      { t: mic, o: { name: 'mic', source: 'microphone', dtx: true } },
    ]);
    expect(VIDEO_MAX_BITRATE).toBe(350_000);
  });

  test('setVideoTracks publishes the 128 and 64 faces too, each its own track', async () => {
    const t = transport();
    const [a, b, c] = [track('video', 'c256'), track('video', 'c128'), track('video', 'c64')];
    t.setVideoTracks(faceTracks(a, b, c));
    await flush();
    expect(publishCalls()).toEqual([
      { t: a, o: expect.objectContaining({ name: 'face', source: 'camera' }) },
      {
        t: b,
        o: {
          name: 'face-128',
          source: 'unknown',
          simulcast: false,
          videoEncoding: { maxBitrate: FACE_128_MAX_BITRATE, maxFramerate: 24 },
        },
      },
      {
        t: c,
        o: {
          name: 'face-64',
          source: 'unknown',
          simulcast: false,
          videoEncoding: { maxBitrate: FACE_64_MAX_BITRATE, maxFramerate: 15 },
        },
      },
      { t: mic, o: expect.objectContaining({ name: 'mic' }) },
    ]);
    expect([FACE_128_MAX_BITRATE, FACE_64_MAX_BITRATE]).toEqual([120_000, 35_000]);
  });

  test('the raw camera (hidden tab) is scaled down to each small size, and back to 1 for the canvases', async () => {
    const t = transport();
    const cam = sized(track('video', 'raw', true, [640, 480]));
    t.setVideoTracks(faceTracks(cam, cam, cam));
    await flush();
    const scale = (name: string) => room().localTrack(name)?.sender.encodings[0]?.scaleResolutionDownBy;
    expect([scale('face'), scale('face-128'), scale('face-64')]).toEqual([undefined, 3.75, 7.5]);
    const canvases = [256, 128, 64].map((n) => sized(track('video', `c${n}`, true, [n, n])));
    t.setVideoTracks(faceTracks(canvases[0] as Track, canvases[1] as Track, canvases[2] as Track));
    await flush();
    expect([scale('face-128'), scale('face-64')]).toEqual([1, 1]);
  });

  test('no local media publishes nothing', async () => {
    transport({ localStream: null });
    await flush();
    expect(publishCalls()).toEqual([]);
  });

  test('setVideoTracks before connecting publishes that track as the face', async () => {
    const t = transport();
    const canvas = track('video', 'canvas');
    t.setVideoTracks(faceTracks(canvas, track('video', 'b'), track('video', 'c')));
    await flush();
    expect(publishCalls()[0]?.t).toBe(canvas);
  });

  test('a mic muted in the lobby stays muted when published (LiveKit re-enables it)', async () => {
    mic.enabled = false;
    transport();
    await flush();
    expect(room().localTrack('mic')).toBeDefined();
    expect(mic.enabled).toBe(false);
  });

  test('a failed publish holds back no other track, and is retried after a backoff', async () => {
    FakeRoom.onConnect = (r) => r.localParticipant.publishTrack.mockRejectedValueOnce(new Error('publish timed out'));
    transport();
    await flush();
    expect(room().publications.map((p) => p.trackName)).toEqual(['mic']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(room().publications.map((p) => p.trackName)).toEqual(['mic', 'face']);
  });

  test('a muted mic stays muted when its publish fails after LiveKit re-enabled it', async () => {
    mic.enabled = false;
    FakeRoom.onConnect = (r) =>
      r.localParticipant.publishTrack
        .mockImplementationOnce(async (t: Track, opts: { name: string }) => {
          const pub = { trackName: opts.name, track: new FakeLocalTrack(t) };
          r.publications.push(pub);
          return pub;
        })
        .mockImplementationOnce(async (t: Track) => {
          t.enabled = true;
          throw new Error('pcManager is not ready');
        });
    transport();
    await flush();
    expect(mic.enabled).toBe(false);
  });
});

describe('which face sizes go out', () => {
  const [a, b, c] = [track('video', 'c256'), track('video', 'c128'), track('video', 'c64')];
  /** Sets the one encoding of the published face `name`, as dynacast leaves it. */
  const encoding = (name: string, e: RTCRtpEncodingParameters) => {
    const sender = room().localTrack(name)?.sender;
    if (sender) {
      sender.encodings = [e];
    }
  };

  test('nothing goes out before the faces are published', async () => {
    const t = transport({ localStream: null });
    expect(t.sendingFaces()).toEqual({ 256: false, 128: false, 64: false });
    await flush();
    expect(t.sendingFaces()).toEqual({ 256: false, 128: false, 64: false });
  });

  test('a size goes out while dynacast keeps its encoding on, and stops while it is off', async () => {
    const t = transport();
    t.setVideoTracks(faceTracks(a, b, c));
    await flush();
    encoding('face', { active: true, maxBitrate: VIDEO_MAX_BITRATE });
    encoding('face-128', { active: false, maxBitrate: FACE_128_MAX_BITRATE });
    encoding('face-64', { active: true, maxBitrate: FACE_64_MAX_BITRATE });
    expect(t.sendingFaces()).toEqual({ 256: true, 128: false, 64: true });
  });

  test('in Firefox, which can’t switch an encoding off, a size LiveKit turned down to its floor counts as paused', async () => {
    const t = transport();
    t.setVideoTracks(faceTracks(a, b, c));
    await flush();
    encoding('face', { active: true, maxBitrate: 10, scaleResolutionDownBy: 4 });
    encoding('face-128', { active: true, maxBitrate: FACE_128_MAX_BITRATE });
    encoding('face-64', { active: true, maxBitrate: 10, scaleResolutionDownBy: 4 });
    expect(t.sendingFaces()).toEqual({ 256: false, 128: true, 64: false });
  });

  test('once closed, nothing goes out', async () => {
    const t = transport();
    t.setVideoTracks(faceTracks(a, b, c));
    await flush();
    for (const name of ['face', 'face-128', 'face-64']) {
      encoding(name, { active: true, maxBitrate: VIDEO_MAX_BITRATE });
    }
    t.close();
    expect(t.sendingFaces()).toEqual({ 256: false, 128: false, 64: false });
  });
});

describe('swapping tracks', () => {
  test('video and mic swaps replace the published track as user-provided, never republish', async () => {
    const t = transport();
    await flush();
    const canvas = track('video', 'canvas');
    const headset = track('audio', 'headset');
    t.setVideoTracks(faceTracks(canvas, camera, camera));
    t.setAudioTrack(asTrack(headset));
    await flush();
    expect(room().localTrack('face')?.replaceTrack).toHaveBeenCalledWith(canvas, { userProvidedTrack: true });
    expect(room().localTrack('mic')?.replaceTrack).toHaveBeenCalledWith(headset, { userProvidedTrack: true });
    expect(room().localParticipant.publishTrack).toHaveBeenCalledTimes(4);
    expect(room().publications.map((p) => p.trackName)).toEqual(['face', 'mic', 'face-128', 'face-64']);
  });

  test('switching to a new mic while muted keeps it muted', async () => {
    const t = transport();
    await flush();
    const headset = track('audio', 'headset', false);
    t.setAudioTrack(asTrack(headset));
    await flush();
    expect(headset.enabled).toBe(false);
  });

  test('after an ended mic (LiveKit mutes the publication) a replacement mic is heard again', async () => {
    const t = transport();
    await flush();
    const lk = room().localTrack('mic') as FakeLocalTrack;
    await lk.mute();
    const fresh = track('audio', 'default-mic');
    t.setAudioTrack(asTrack(fresh));
    await flush();
    expect(lk.unmute).toHaveBeenCalled();
    expect(lk.isMuted).toBe(false);
    expect(fresh.enabled).toBe(true);
  });

  test('the boombox is published, replaced, unpublished without stopping, and published again', async () => {
    const t = transport();
    await flush();
    const song = track('audio', 'song');
    t.setBoomboxTrack(asTrack(song));
    await flush();
    expect(publishCalls()[2]).toEqual({
      t: song,
      o: {
        name: 'boombox',
        source: 'screen_share_audio',
        audioPreset: { maxBitrate: BOOMBOX_MAX_BITRATE },
        forceStereo: false,
        dtx: false,
        red: false,
      },
    });
    expect(BOOMBOX_MAX_BITRATE).toBe(64_000);
    const next = track('audio', 'next');
    t.setBoomboxTrack(asTrack(next));
    await flush();
    expect(room().localTrack('boombox')?.replaceTrack).toHaveBeenCalledWith(next, { userProvidedTrack: true });
    t.setBoomboxTrack(null);
    await flush();
    expect(room().localParticipant.unpublishTrack).toHaveBeenCalledWith(expect.any(FakeLocalTrack), false);
    expect(next.stopped).toBeUndefined();
    t.setBoomboxTrack(asTrack(song));
    await flush();
    expect(room().localParticipant.publishTrack).toHaveBeenCalledTimes(4);
    expect(room().publications.map((p) => p.trackName)).toEqual(['face', 'mic', 'boombox']);
  });

  test('swaps keep working after LiveKit republishes everything (signal restart)', async () => {
    const t = transport();
    await flush();
    t.setBoomboxTrack(asTrack(track('audio', 'song')));
    await flush();
    room().republish();
    const raw = track('video', 'raw-camera');
    t.setVideoTracks(faceTracks(raw, raw, raw));
    t.setBoomboxTrack(null);
    await flush();
    expect(room().localTrack('face')?.mediaStreamTrack).toBe(raw);
    expect(room().publications.map((p) => p.trackName)).toEqual(['face', 'mic', 'face-128', 'face-64']);
    expect(room().localParticipant.publishTrack).toHaveBeenCalledTimes(5);
  });
});

describe('remote media', () => {
  const ALL = ['face', 'face-128', 'face-64', 'mic', 'boombox'];
  const ON = { video: 256, audio: true } as const;

  test('nothing is subscribed until wanted', async () => {
    transport();
    await flush();
    room().publishRemote('p1', ALL);
    expect(room().asked('p1')).toEqual([]);
  });

  test("a participant's face and voice arrive as separate streams", async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ALL);
    t.setWanted('p1', ON);
    expect(room().asked('p1').sort()).toEqual(['boombox', 'face', 'mic']);
    const face = track('video', 'p1-face');
    const voice = track('audio', 'p1-mic');
    room().deliver('p1', 'face', face);
    room().deliver('p1', 'mic', voice);
    expect(remote).toEqual([{ peerId: 'p1', tracks: [face] }]);
    expect(voices).toEqual([{ peerId: 'p1', tracks: [voice] }]);
  });

  test('face changes (off, on, another size) never re-emit the voice', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ALL);
    t.setWanted('p1', { video: 64, audio: true });
    room().deliver('p1', 'mic', track('audio', 'v'));
    room().deliver('p1', 'face-64', track('video', 'small'));
    t.setWanted('p1', { video: 256, audio: true });
    room().deliver('p1', 'face', track('video', 'big'));
    t.setWanted('p1', { video: 'off', audio: true });
    t.setWanted('p1', { video: 128, audio: true });
    room().deliver('p1', 'face-128', track('video', 'mid'));
    expect(remote.map((r) => r.tracks.map((x) => x.id))).toEqual([['small'], ['big'], [], ['mid']]);
    expect(voices).toHaveLength(1);
  });

  test('participants already in the room when we connect are found too', async () => {
    FakeRoom.onConnect = (r) => r.publishRemote('p1', ALL, { silently: true });
    const t = transport();
    await flush();
    t.setWanted('p1', { video: 64, audio: false });
    expect(room().asked('p1')).toEqual(['face-64']);
  });

  test('wants set before the publications arrive are applied when they do', async () => {
    const t = transport();
    await flush();
    t.setWanted('p1', { video: 128, audio: true });
    room().publishRemote('p1', ALL);
    expect(room().asked('p1').sort()).toEqual(['boombox', 'face-128', 'mic']);
  });

  test.each([
    [256, 'face'],
    [128, 'face-128'],
    [64, 'face-64'],
  ] as const)('video %s subscribes only %s', async (video, name) => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ALL);
    t.setWanted('p1', { video, audio: false });
    expect(room().asked('p1')).toEqual([name]);
  });

  test('a size switch keeps the old face until the new one arrives, then swaps and drops the old', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ALL);
    t.setWanted('p1', { video: 128, audio: false });
    const small = track('video', 'small');
    room().deliver('p1', 'face-128', small);
    t.setWanted('p1', { video: 256, audio: false });
    expect(room().asked('p1').sort()).toEqual(['face', 'face-128']);
    expect(remote.at(-1)).toEqual({ peerId: 'p1', tracks: [small] });
    const big = track('video', 'big');
    room().deliver('p1', 'face', big);
    expect(remote.at(-1)).toEqual({ peerId: 'p1', tracks: [big] });
    expect(room().asked('p1')).toEqual(['face']);
    expect(room().pub('p1', 'face-128').subscribed).toBe(false);
  });

  test('a track that arrives after it stopped being wanted is dropped, not shown', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ALL);
    t.setWanted('p1', { video: 128, audio: false });
    t.setWanted('p1', { video: 'off', audio: false });
    room().deliver('p1', 'face-128', track('video', 'late'));
    expect(remote).toEqual([]);
    expect(room().pub('p1', 'face-128').subscribed).toBe(false);
  });

  test('video off unsubscribes the face; audio false unsubscribes mic and boombox', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ALL);
    t.setWanted('p1', ON);
    const voice = track('audio', 'v');
    room().deliver('p1', 'face', track('video', 'f'));
    room().deliver('p1', 'mic', voice);
    room().deliver('p1', 'boombox', track('audio', 'b'));
    t.setWanted('p1', { video: 'off', audio: true });
    expect(room().asked('p1').sort()).toEqual(['boombox', 'mic']);
    expect(remote.at(-1)).toEqual({ peerId: 'p1', tracks: [] });
    expect(voices.at(-1)).toEqual({ peerId: 'p1', tracks: [voice] });
    t.setWanted('p1', { video: 'off', audio: false });
    expect(room().asked('p1')).toEqual([]);
    expect(voices.at(-1)).toEqual({ peerId: 'p1', tracks: [] });
    expect(room().pub('p1', 'mic').subscribed).toBe(false);
    expect(room().pub('p1', 'boombox').subscribed).toBe(false);
  });

  test('a peer that only publishes face (an older client) gets face for any size', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ['face', 'mic']);
    for (const video of [64, 128, 256] as const) {
      t.setWanted('p1', { video, audio: false });
      expect(room().asked('p1')).toEqual(['face']);
    }
  });

  test('a missing size falls back to the nearest one published', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ['face', 'face-128']);
    t.setWanted('p1', { video: 64, audio: false });
    expect(room().asked('p1')).toEqual(['face-128']);
  });

  test('a mic without a face makes a voice; the boombox gets its own stream', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p2', ALL);
    t.setWanted('p2', { video: 'off', audio: true });
    const voice = track('audio', 'p2-mic');
    const music = track('audio', 'p2-music');
    room().deliver('p2', 'mic', voice);
    room().deliver('p2', 'boombox', music);
    expect(remote).toEqual([]);
    expect(voices).toEqual([{ peerId: 'p2', tracks: [voice] }]);
    expect(boomboxes).toEqual([{ peerId: 'p2', tracks: [music] }]);
  });

  test('an unsubscribed mic empties the voice and leaves the face alone', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ALL);
    t.setWanted('p1', ON);
    const face = track('video', 'f');
    const voice = room().deliver('p1', 'mic', track('audio', 'm'));
    room().deliver('p1', 'face', face);
    room().emit('trackUnsubscribed', voice, room().pub('p1', 'mic'), { identity: 'p1' });
    expect(voices.at(-1)).toEqual({ peerId: 'p1', tracks: [] });
    expect(remote).toEqual([{ peerId: 'p1', tracks: [face] }]);
  });

  test('stats split face+mic bytes from boombox bytes', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ALL);
    t.setWanted('p1', ON);
    room().deliver('p1', 'face', track('video', 'f'), 1000);
    room().deliver('p1', 'mic', track('audio', 'm'), 200);
    room().deliver('p1', 'boombox', track('audio', 'b'), 50);
    expect(await t.stats('p1')).toEqual({ bytesReceived: 1200, boomboxBytesReceived: 50 });
    expect(await t.stats('nobody')).toBeNull();
    room().emit('participantDisconnected', { identity: 'p1' });
    expect(await t.stats('p1')).toBeNull();
  });

  test('publishes: only participants with tracks in LiveKit (bots never join it)', async () => {
    const t = transport();
    await flush();
    expect(t.publishes('p1')).toBe(false);
    room().publishRemote('p1', ['face']);
    expect(t.publishes('p1')).toBe(true);
    room().emit('trackUnpublished', room().pub('p1', 'face'), { identity: 'p1' });
    expect(t.publishes('p1')).toBe(false);
    room().publishRemote('p1', ['face']);
    room().emit('participantDisconnected', { identity: 'p1' });
    expect(t.publishes('p1')).toBe(false);
  });

  test('wants survive a reconnect: the new room subscribes the same', async () => {
    const t = transport();
    await flush();
    t.setWanted('p1', { video: 64, audio: true });
    room().lose();
    await vi.advanceTimersByTimeAsync(1000);
    room(1).publishRemote('p1', ALL);
    expect(room(1).asked('p1').sort()).toEqual(['boombox', 'face-64', 'mic']);
  });

  test('a room that was closed or replaced is ignored', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ALL);
    t.setWanted('p1', ON);
    room().lose();
    await vi.advanceTimersByTimeAsync(1000);
    room(0).deliver('p1', 'face', track('video', 'stale'));
    expect(remote).toEqual([]);
    expect(voices).toEqual([]);
    t.close();
    room(1).publishRemote('p1', ALL);
    room(1).deliver('p1', 'face', track('video', 'late'));
    expect(remote).toEqual([]);
  });
});

describe('lifecycle', () => {
  test('close disconnects without stopping our tracks, and later calls are harmless', async () => {
    const t = transport();
    await flush();
    t.close();
    await flush();
    expect(room().disconnectArgs).toEqual([false]);
    expect(camera.stopped).toBeUndefined();
    expect(mic.stopped).toBeUndefined();
    t.setBoomboxTrack(asTrack(track('audio', 'late')));
    t.setVideoTracks(faceTracks(track('video', 'late'), camera, camera));
    await flush();
    expect(room().localParticipant.publishTrack).toHaveBeenCalledTimes(2);
  });

  test('a failed connect is retried with a fresh room after a backoff', async () => {
    FakeRoom.failConnects = 1;
    transport();
    await flush();
    expect(FakeRoom.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeRoom.instances).toHaveLength(2);
    expect(room(1).localParticipant.publishTrack).toHaveBeenCalledTimes(2);
  });

  test('a failed livekit-client load is retried instead of leaving the room silent', async () => {
    const loadRoom = vi
      .fn<() => Promise<NonNullable<LiveKitTransportOptions['RoomImpl']>>>()
      .mockRejectedValueOnce(new Error('chunk 404'))
      .mockResolvedValue(FakeRoom as unknown as NonNullable<LiveKitTransportOptions['RoomImpl']>);
    transport({ loadRoom });
    await flush();
    expect(FakeRoom.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeRoom.instances).toHaveLength(1);
  });

  test('when LiveKit gives up, it reconnects and republishes the same, unstopped tracks', async () => {
    const t = transport();
    await flush();
    room().publishRemote('p1', ['face']);
    t.setWanted('p1', { video: 256, audio: false });
    room().deliver('p1', 'face', track('video', 'f'));
    room().lose();
    expect(await t.stats('p1')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeRoom.instances).toHaveLength(2);
    expect(publishCalls(1).map((c) => c.t)).toEqual([camera, mic]);
    expect(camera.stopped).toBeUndefined();
    expect(mic.stopped).toBeUndefined();
  });

  test('a reconnect uses the latest access the game handed out (tokens expire)', async () => {
    const t = transport();
    await flush();
    t.setAccess({ url: 'ws://lk2', token: 'fresh' });
    room().lose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(room(1).connectArgs.slice(0, 2)).toEqual(['ws://lk2', 'fresh']);
  });

  test('no reconnect after close', async () => {
    const t = transport();
    await flush();
    t.close();
    room().lose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeRoom.instances).toHaveLength(1);
  });
});
