import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BOOMBOX_MAX_BITRATE,
  createLiveKitTransport,
  type LiveKitTransportOptions,
  VIDEO_MAX_BITRATE,
} from './livekit';

type Track = { kind: string; id: string; enabled: boolean; stopped?: boolean };
const track = (kind: string, id: string, enabled = true): Track => ({ kind, id, enabled });
const asTrack = (t: Track) => t as unknown as MediaStreamTrack;

/**
 * livekit-client's LocalTrack as far as this transport meets it (read from livekit-client 2.22 src):
 * - setMediaStreamTrack rewrites `enabled` to `!isMuted` (on publish and on every replaceTrack);
 * - an ended track gets mute()d;
 * - stop() stops the underlying track.
 */
class FakeLocalTrack {
  isMuted = false;
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

class FakeRoom {
  static instances: FakeRoom[] = [];
  static failConnects = 0;
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  connectArgs: unknown[] = [];
  disconnectArgs: unknown[] | null = null;
  publications: { trackName: string; track?: FakeLocalTrack }[] = [];
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
  constructor(public options: { stopLocalTrackOnUnpublish?: boolean }) {
    FakeRoom.instances.push(this);
  }
  async connect(...args: unknown[]) {
    this.connectArgs = args;
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
  /** A remote participant's track arriving. */
  subscribe(identity: string, trackName: string, t: Track, bytes = 0) {
    const remoteTrack = {
      mediaStreamTrack: t,
      getRTCStatsReport: async () => new Map([['x', { type: 'inbound-rtp', bytesReceived: bytes }]]),
    };
    this.emit('trackSubscribed', remoteTrack, { trackName }, { identity });
    return remoteTrack;
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);
let remote: { peerId: string; tracks: Track[] }[];
let boomboxes: { peerId: string; tracks: Track[] }[];
let camera: Track;
let mic: Track;

beforeEach(() => {
  vi.useFakeTimers();
  FakeRoom.instances = [];
  FakeRoom.failConnects = 0;
  remote = [];
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
    onRemoteBoombox: (peerId, s) => boomboxes.push({ peerId, tracks: (s as unknown as { tracks: Track[] }).tracks }),
    createStream: (tracks) => ({ tracks }) as unknown as MediaStream,
    loadRoom: async () => FakeRoom as unknown as NonNullable<LiveKitTransportOptions['RoomImpl']>,
    ...over,
  });
}
const room = (i = 0) => FakeRoom.instances[i] as FakeRoom;
const publishCalls = (i = 0) => room(i).localParticipant.publishTrack.mock.calls.map(([t, o]) => ({ t, o }));

describe('connecting and publishing', () => {
  test('connects with the token; receives everyone; never lets LiveKit stop our tracks', async () => {
    transport();
    await flush();
    expect(room().options).toEqual({ adaptiveStream: false, dynacast: false, stopLocalTrackOnUnpublish: false });
    expect(room().connectArgs).toEqual(['ws://lk', 'tok', { autoSubscribe: true }]);
  });

  test('publishes the face then the mic, by name, with their encodings', async () => {
    transport();
    await flush();
    expect(publishCalls()).toEqual([
      {
        t: camera,
        o: { name: 'face', source: 'camera', simulcast: false, videoEncoding: { maxBitrate: VIDEO_MAX_BITRATE } },
      },
      { t: mic, o: { name: 'mic', source: 'microphone', dtx: true } },
    ]);
    expect(VIDEO_MAX_BITRATE).toBe(350_000);
  });

  test('no local media publishes nothing', async () => {
    transport({ localStream: null });
    await flush();
    expect(publishCalls()).toEqual([]);
  });

  test('setVideoTrack before connecting publishes that track as the face', async () => {
    const t = transport();
    const canvas = track('video', 'canvas');
    t.setVideoTrack(asTrack(canvas));
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
});

describe('swapping tracks', () => {
  test('video and mic swaps replace the published track as user-provided, never republish', async () => {
    const t = transport();
    await flush();
    const canvas = track('video', 'canvas');
    const headset = track('audio', 'headset');
    t.setVideoTrack(asTrack(canvas));
    t.setAudioTrack(asTrack(headset));
    await flush();
    expect(room().localTrack('face')?.replaceTrack).toHaveBeenCalledWith(canvas, { userProvidedTrack: true });
    expect(room().localTrack('mic')?.replaceTrack).toHaveBeenCalledWith(headset, { userProvidedTrack: true });
    expect(room().localParticipant.publishTrack).toHaveBeenCalledTimes(2);
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
        dtx: false,
        red: false,
      },
    });
    expect(BOOMBOX_MAX_BITRATE).toBe(128_000);
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
    t.setVideoTrack(asTrack(raw));
    t.setBoomboxTrack(null);
    await flush();
    expect(room().localTrack('face')?.mediaStreamTrack).toBe(raw);
    expect(room().publications.map((p) => p.trackName)).toEqual(['face', 'mic']);
    expect(room().localParticipant.publishTrack).toHaveBeenCalledTimes(3);
  });
});

describe('remote media', () => {
  test("a participant's face and mic become one stream, re-emitted as a new stream when the mic arrives", async () => {
    transport();
    await flush();
    const face = track('video', 'p1-face');
    const voice = track('audio', 'p1-mic');
    room().subscribe('p1', 'face', face);
    room().subscribe('p1', 'mic', voice);
    expect(remote).toEqual([
      { peerId: 'p1', tracks: [face] },
      { peerId: 'p1', tracks: [face, voice] },
    ]);
  });

  test('a mic without a face still makes a stream; the boombox gets its own', async () => {
    transport();
    await flush();
    const voice = track('audio', 'p2-mic');
    const music = track('audio', 'p2-music');
    room().subscribe('p2', 'mic', voice);
    room().subscribe('p2', 'boombox', music);
    expect(remote).toEqual([{ peerId: 'p2', tracks: [voice] }]);
    expect(boomboxes).toEqual([{ peerId: 'p2', tracks: [music] }]);
  });

  test('an unsubscribed mic is dropped from the re-emitted stream', async () => {
    transport();
    await flush();
    const face = track('video', 'f');
    const voice = room().subscribe('p1', 'mic', track('audio', 'm'));
    room().subscribe('p1', 'face', face);
    room().emit('trackUnsubscribed', voice, { trackName: 'mic' }, { identity: 'p1' });
    expect(remote.at(-1)).toEqual({ peerId: 'p1', tracks: [face] });
  });

  test('stats split face+mic bytes from boombox bytes', async () => {
    const t = transport();
    await flush();
    room().subscribe('p1', 'face', track('video', 'f'), 1000);
    room().subscribe('p1', 'mic', track('audio', 'm'), 200);
    room().subscribe('p1', 'boombox', track('audio', 'b'), 50);
    expect(await t.stats('p1')).toEqual({ bytesReceived: 1200, boomboxBytesReceived: 50 });
    expect(await t.stats('nobody')).toBeNull();
    room().emit('participantDisconnected', { identity: 'p1' });
    expect(await t.stats('p1')).toBeNull();
  });

  test('a room that was closed or replaced is ignored', async () => {
    const t = transport();
    await flush();
    room().lose();
    await vi.advanceTimersByTimeAsync(1000);
    room(0).subscribe('p1', 'face', track('video', 'stale'));
    expect(remote).toEqual([]);
    t.close();
    room(1).subscribe('p1', 'face', track('video', 'late'));
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
    t.setVideoTrack(asTrack(track('video', 'late')));
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
    room().subscribe('p1', 'face', track('video', 'f'));
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
