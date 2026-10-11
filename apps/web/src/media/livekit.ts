// MediaTransport over the LiveKit SFU (LiveKit spec §4): our face, mic and boombox are published once, by name,
// and LiveKit forwards everyone's tracks to everyone (autoSubscribe; selective subscription is 6c).
// Local tracks are user-provided: LocalMediaController owns them, so they are swapped with replaceTrack and never
// stopped. livekit-client itself is loaded with import() on first connect, keeping it out of the lobby bundle.
import type { RoomConnectOptions, RoomOptions, TrackPublishOptions } from 'livekit-client';
import type { MediaTransport } from './transport';

export const VIDEO_MAX_BITRATE = 350_000;
/** Music, not speech: well above Opus's ~32 kbps default (boombox spec §5.3). */
export const BOOMBOX_MAX_BITRATE = 128_000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

type TrackName = 'face' | 'mic' | 'boombox';

interface LocalPublicationLike {
  track?: {
    mediaStreamTrack: MediaStreamTrack;
    replaceTrack(track: MediaStreamTrack, options: { userProvidedTrack: boolean }): Promise<unknown>;
  };
}

interface RemoteTrackLike {
  mediaStreamTrack: MediaStreamTrack;
  getRTCStatsReport(): Promise<RTCStatsReport | undefined>;
}

/** The part of livekit-client's Room this transport uses; tests pass a fake. */
export interface LiveKitRoomLike {
  connect(url: string, token: string, options?: RoomConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  localParticipant: {
    publishTrack(track: MediaStreamTrack, options: TrackPublishOptions): Promise<LocalPublicationLike>;
    unpublishTrack(track: MediaStreamTrack, stopOnUnpublish?: boolean): Promise<unknown>;
  };
}

export interface LiveKitTransportOptions {
  url: string;
  token: string;
  localStream: MediaStream | null;
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  onRemoteBoombox: (peerId: string, stream: MediaStream) => void;
  RoomImpl?: new (options: Partial<RoomOptions>) => LiveKitRoomLike;
  createStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}

// Track.Source and RoomEvent values, as strings so livekit-client isn't imported eagerly.
const PUBLISH: Record<TrackName, TrackPublishOptions> = {
  face: {
    name: 'face',
    source: 'camera' as TrackPublishOptions['source'],
    simulcast: false,
    videoEncoding: { maxBitrate: VIDEO_MAX_BITRATE },
  },
  mic: { name: 'mic', source: 'microphone' as TrackPublishOptions['source'], dtx: true },
  boombox: {
    name: 'boombox',
    source: 'screen_share_audio' as TrackPublishOptions['source'],
    audioPreset: { maxBitrate: BOOMBOX_MAX_BITRATE },
    dtx: false,
    red: false,
  },
};
const NAMES: TrackName[] = ['face', 'mic', 'boombox'];

export function createLiveKitTransport(opts: LiveKitTransportOptions): MediaTransport {
  const createStream = opts.createStream ?? ((tracks: MediaStreamTrack[]) => new MediaStream(tracks));
  const local = opts.localStream;
  const wanted: Record<TrackName, MediaStreamTrack | null> = {
    face: local?.getVideoTracks()[0] ?? null,
    mic: local?.getAudioTracks()[0] ?? null,
    boombox: null,
  };
  let published: Record<TrackName, LocalPublicationLike | null> = { face: null, mic: null, boombox: null };
  /** identity → track name → subscribed track. */
  const remotes = new Map<string, Map<string, RemoteTrackLike>>();
  let room: LiveKitRoomLike | null = null;
  let connected = false;
  let closed = false;
  let retryMs = RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Publishing is serialized: every change reconciles what is published with what is wanted.
  let queue = Promise.resolve();

  async function reconcile(r: LiveKitRoomLike) {
    for (const name of NAMES) {
      if (r !== room || closed) {
        return;
      }
      const want = wanted[name];
      const pub = published[name];
      const current = pub?.track?.mediaStreamTrack ?? null;
      if (!want) {
        if (current) {
          await r.localParticipant.unpublishTrack(current, false);
        }
        published[name] = null;
      } else if (!pub) {
        published[name] = await r.localParticipant.publishTrack(want, PUBLISH[name]);
      } else if (current !== want) {
        await pub.track?.replaceTrack(want, { userProvidedTrack: true });
      }
    }
  }

  const update = () => {
    queue = queue
      .then(() => (room && connected ? reconcile(room) : undefined))
      .catch((err) => console.warn('livekit publish failed', err));
  };

  /** Face and mic of one participant as a new stream: the audio engine ignores a stream object it already has. */
  const emitStream = (identity: string) => {
    const tracks = remotes.get(identity);
    const list = (['face', 'mic'] as const)
      .map((name) => tracks?.get(name)?.mediaStreamTrack)
      .filter((t): t is MediaStreamTrack => t !== undefined);
    if (list.length > 0) {
      opts.onRemoteStream(identity, createStream(list));
    }
  };

  const onSubscribed = (track: RemoteTrackLike, pub: { trackName: string }, participant: { identity: string }) => {
    const { identity } = participant;
    const tracks = remotes.get(identity) ?? new Map<string, RemoteTrackLike>();
    remotes.set(identity, tracks);
    tracks.set(pub.trackName, track);
    if (pub.trackName === 'boombox') {
      opts.onRemoteBoombox(identity, createStream([track.mediaStreamTrack]));
    } else if (pub.trackName === 'face' || pub.trackName === 'mic') {
      emitStream(identity);
    }
  };

  const onUnsubscribed = (_track: RemoteTrackLike, pub: { trackName: string }, participant: { identity: string }) => {
    remotes.get(participant.identity)?.delete(pub.trackName);
    if (pub.trackName === 'face' || pub.trackName === 'mic') {
      emitStream(participant.identity);
    }
  };

  const retry = () => {
    if (closed) {
      return;
    }
    retryTimer = setTimeout(() => void start(), retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  async function start() {
    retryTimer = null;
    if (closed) {
      return;
    }
    const Impl =
      opts.RoomImpl ?? ((await import('livekit-client')).Room as unknown as LiveKitTransportOptions['RoomImpl']);
    if (!Impl || closed) {
      return;
    }
    const r = new Impl({ adaptiveStream: false, dynacast: false });
    room = r;
    connected = false;
    published = { face: null, mic: null, boombox: null };
    r.on('trackSubscribed', onSubscribed as (...args: never[]) => void);
    r.on('trackUnsubscribed', onUnsubscribed as (...args: never[]) => void);
    r.on('participantDisconnected', ((participant: { identity: string }) => {
      remotes.delete(participant.identity);
    }) as (...args: never[]) => void);
    // LiveKit gave up reconnecting (or the server went away): start over with a fresh room.
    r.on('disconnected', () => {
      if (r !== room || closed) {
        return;
      }
      room = null;
      connected = false;
      remotes.clear();
      retry();
    });
    try {
      await r.connect(opts.url, opts.token, { autoSubscribe: true });
    } catch (err) {
      console.warn('livekit connect failed', err);
      if (r === room) {
        room = null;
        retry();
      }
      return;
    }
    if (r !== room || closed) {
      void r.disconnect();
      return;
    }
    connected = true;
    retryMs = RETRY_MIN_MS;
    update();
  }

  void start();

  return {
    // LiveKit forwards every participant; per-peer subscription arrives with visibility (6c).
    connect() {},
    disconnect() {},
    async handleSignal() {},
    close() {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      const r = room;
      room = null;
      connected = false;
      remotes.clear();
      void r?.disconnect();
    },
    async stats(peerId) {
      const tracks = remotes.get(peerId);
      if (!tracks) {
        return null;
      }
      let bytesReceived = 0;
      let boomboxBytesReceived = 0;
      for (const [name, track] of tracks) {
        const report = await track.getRTCStatsReport();
        report?.forEach((s: { type: string; bytesReceived?: number }) => {
          if (s.type !== 'inbound-rtp') {
            return;
          }
          if (name === 'boombox') {
            boomboxBytesReceived += s.bytesReceived ?? 0;
          } else {
            bytesReceived += s.bytesReceived ?? 0;
          }
        });
      }
      return { bytesReceived, boomboxBytesReceived };
    },
    setVideoTrack(track) {
      wanted.face = track;
      update();
    },
    setAudioTrack(track) {
      wanted.mic = track;
      update();
    },
    setBoomboxTrack(track) {
      wanted.boombox = track;
      update();
    },
  };
}
