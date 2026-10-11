import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BOOMBOX_MAX_BITRATE,
  createLiveKitTransport,
  type LiveKitTransportOptions,
  VIDEO_MAX_BITRATE,
} from './livekit';

type Track = { kind: string; id: string };
const track = (kind: string, id: string): Track => ({ kind, id });
const camera = track('video', 'camera');
const mic = track('audio', 'mic');

/** A published local track as livekit-client returns it. */
class FakePublication {
  constructor(
    public trackName: string,
    t: Track
  ) {
    this.track = { mediaStreamTrack: t, replaceTrack: vi.fn(async (next: Track) => this.swap(next)) };
  }
  track: { mediaStreamTrack: Track; replaceTrack: ReturnType<typeof vi.fn> };
  private swap(next: Track) {
    this.track.mediaStreamTrack = next;
  }
}

class FakeRoom {
  static instances: FakeRoom[] = [];
  static failConnects = 0;
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  connectArgs: unknown[] = [];
  disconnected = false;
  published: FakePublication[] = [];
  localParticipant = {
    publishTrack: vi.fn(async (t: Track, opts: { name: string }) => {
      const pub = new FakePublication(opts.name, t);
      this.published.push(pub);
      return pub;
    }),
    unpublishTrack: vi.fn(async (t: Track, stop?: boolean) => {
      this.published = this.published.filter((p) => p.track.mediaStreamTrack !== t);
      return stop;
    }),
  };
  constructor(public options: unknown) {
    FakeRoom.instances.push(this);
  }
  async connect(...args: unknown[]) {
    this.connectArgs = args;
    if (FakeRoom.failConnects > 0) {
      FakeRoom.failConnects--;
      throw new Error('connect failed');
    }
  }
  async disconnect() {
    this.disconnected = true;
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

beforeEach(() => {
  vi.useFakeTimers();
  FakeRoom.instances = [];
  FakeRoom.failConnects = 0;
  remote = [];
  boomboxes = [];
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
    RoomImpl: FakeRoom as unknown as LiveKitTransportOptions['RoomImpl'],
    ...over,
  });
}
const room = (i = 0) => FakeRoom.instances[i] as FakeRoom;
const publishCalls = () => room().localParticipant.publishTrack.mock.calls.map(([t, o]) => ({ t, o }));

describe('connecting and publishing', () => {
  test('connects to the url with the token; everyone is received, no adaptive stream or dynacast', async () => {
    transport();
    await flush();
    expect(room().options).toMatchObject({ adaptiveStream: false, dynacast: false });
    expect(room().connectArgs).toEqual(['ws://lk', 'tok', { autoSubscribe: true }]);
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
          videoEncoding: { maxBitrate: VIDEO_MAX_BITRATE },
        },
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
    t.setVideoTrack(canvas as unknown as MediaStreamTrack);
    await flush();
    expect(publishCalls()[0]?.t).toBe(canvas);
  });
});

describe('swapping tracks', () => {
  test('video and mic swaps replace the published track as user-provided, never republish', async () => {
    const t = transport();
    await flush();
    const canvas = track('video', 'canvas');
    const headset = track('audio', 'headset');
    t.setVideoTrack(canvas as unknown as MediaStreamTrack);
    t.setAudioTrack(headset as unknown as MediaStreamTrack);
    await flush();
    const [face, voice] = room().published;
    expect(face?.track.replaceTrack).toHaveBeenCalledWith(canvas, { userProvidedTrack: true });
    expect(voice?.track.replaceTrack).toHaveBeenCalledWith(headset, { userProvidedTrack: true });
    expect(room().localParticipant.publishTrack).toHaveBeenCalledTimes(2);
  });

  test('the boombox is published, replaced, unpublished without stopping, and published again', async () => {
    const t = transport();
    await flush();
    const song = track('audio', 'song');
    t.setBoomboxTrack(song as unknown as MediaStreamTrack);
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
    t.setBoomboxTrack(next as unknown as MediaStreamTrack);
    await flush();
    expect(room().published[2]?.track.replaceTrack).toHaveBeenCalledWith(next, { userProvidedTrack: true });
    t.setBoomboxTrack(null);
    await flush();
    expect(room().localParticipant.unpublishTrack).toHaveBeenCalledWith(next, false);
    t.setBoomboxTrack(song as unknown as MediaStreamTrack);
    await flush();
    expect(room().localParticipant.publishTrack).toHaveBeenCalledTimes(4);
    expect(room().published.map((p) => p.trackName)).toEqual(['face', 'mic', 'boombox']);
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
});

describe('lifecycle', () => {
  test('close disconnects the room, and later calls are harmless', async () => {
    const t = transport();
    await flush();
    t.close();
    await flush();
    expect(room().disconnected).toBe(true);
    t.setBoomboxTrack(track('audio', 'late') as unknown as MediaStreamTrack);
    t.setVideoTrack(track('video', 'late') as unknown as MediaStreamTrack);
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

  test('a LiveKit disconnect reconnects and republishes, forgetting remote tracks', async () => {
    const t = transport();
    await flush();
    room().subscribe('p1', 'face', track('video', 'f'));
    room().emit('disconnected');
    expect(await t.stats('p1')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeRoom.instances).toHaveLength(2);
    expect(room(1).published.map((p) => p.trackName)).toEqual(['face', 'mic']);
  });

  test('no reconnect after close', async () => {
    const t = transport();
    await flush();
    t.close();
    room().emit('disconnected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeRoom.instances).toHaveLength(1);
  });
});
