// MediaTransport over the LiveKit SFU (LiveKit spec §4): our face, mic and boombox are published once, by name,
// and LiveKit forwards everyone's tracks to everyone (autoSubscribe; selective subscription is 6c).
// Local tracks are user-provided: LocalMediaController owns them, so they are swapped with replaceTrack and LiveKit
// must never stop them (stopLocalTrackOnUnpublish: false, disconnect(false)), nor decide whether they are enabled:
// it rewrites `enabled` on publish and replace, and mutes a publication whose track ended, so both are undone.
// livekit-client itself is loaded with import() on first connect, keeping it out of the lobby bundle.

import type { LiveKitAccess } from '@zoom3d/shared';
import type { RoomConnectOptions, RoomOptions, TrackPublishOptions } from 'livekit-client';
import type { MediaTransport, TransportOptions } from './transport';

export const VIDEO_MAX_BITRATE = 350_000;
/** Music, not speech: well above Opus's ~32 kbps default (boombox spec §5.3). */
export const BOOMBOX_MAX_BITRATE = 128_000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

type TrackName = 'face' | 'mic' | 'boombox';

/** livekit-client's LocalTrack: unlike its publication, it survives a republish (signal restart). */
interface LocalTrackLike {
  mediaStreamTrack: MediaStreamTrack;
  isMuted: boolean;
  replaceTrack(track: MediaStreamTrack, options: { userProvidedTrack: boolean }): Promise<unknown>;
  unmute(): Promise<unknown>;
}

interface RemoteTrackLike {
  mediaStreamTrack: MediaStreamTrack;
  getRTCStatsReport(): Promise<RTCStatsReport | undefined>;
}

/** The part of livekit-client's Room this transport uses; tests pass a fake. */
export interface LiveKitRoomLike {
  connect(url: string, token: string, options?: RoomConnectOptions): Promise<void>;
  disconnect(stopTracks?: boolean): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  localParticipant: {
    publishTrack(track: MediaStreamTrack, options: TrackPublishOptions): Promise<{ track?: LocalTrackLike }>;
    unpublishTrack(track: LocalTrackLike, stopOnUnpublish?: boolean): Promise<unknown>;
  };
}

export interface LiveKitTransportOptions extends TransportOptions {
  RoomImpl?: new (options: Partial<RoomOptions>) => LiveKitRoomLike;
  /** Loads livekit-client's Room; defaults to a dynamic import (a lazy chunk). */
  loadRoom?: () => Promise<NonNullable<LiveKitTransportOptions['RoomImpl']>>;
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

const defaultLoadRoom = async () =>
  (await import('livekit-client')).Room as unknown as NonNullable<LiveKitTransportOptions['RoomImpl']>;

export function createLiveKitTransport(opts: LiveKitTransportOptions): MediaTransport {
  const createStream = opts.createStream ?? ((tracks: MediaStreamTrack[]) => new MediaStream(tracks));
  const local = opts.localStream;
  const wanted: Record<TrackName, MediaStreamTrack | null> = {
    face: local?.getVideoTracks()[0] ?? null,
    mic: local?.getAudioTracks()[0] ?? null,
    boombox: null,
  };
  let access: LiveKitAccess = { url: opts.url, token: opts.token };
  let published: Record<TrackName, LocalTrackLike | null> = { face: null, mic: null, boombox: null };
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
      let lt = published[name];
      if (!want) {
        if (lt) {
          await r.localParticipant.unpublishTrack(lt, false);
        }
        published[name] = null;
        continue;
      }
      if (lt?.mediaStreamTrack === want) {
        continue;
      }
      const enabled = want.enabled;
      if (lt) {
        await lt.replaceTrack(want, { userProvidedTrack: true });
      } else {
        lt = (await r.localParticipant.publishTrack(want, PUBLISH[name])).track ?? null;
        published[name] = lt;
      }
      // Undo LiveKit's say over the track: unmute a publication it muted (its old track ended), and keep the
      // controller's mute (a muted mic must stay silent).
      if (lt?.isMuted) {
        await lt.unmute();
      }
      want.enabled = enabled;
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
    let Impl: LiveKitTransportOptions['RoomImpl'];
    try {
      Impl = opts.RoomImpl ?? (await (opts.loadRoom ?? defaultLoadRoom)());
    } catch (err) {
      // E.g. a tab older than a deploy asks for a chunk that's gone: retrying beats a silent room.
      console.warn('livekit-client failed to load', err);
      retry();
      return;
    }
    if (!Impl || closed) {
      return;
    }
    const r = new Impl({ adaptiveStream: false, dynacast: false, stopLocalTrackOnUnpublish: false });
    room = r;
    connected = false;
    published = { face: null, mic: null, boombox: null };
    /** Events from a room that was closed or replaced must not touch the current one's media. */
    const live = <A extends unknown[]>(fn: (...args: A) => void) =>
      ((...args: A) => {
        if (r === room && !closed) {
          fn(...args);
        }
      }) as unknown as (...args: never[]) => void;
    r.on('trackSubscribed', live(onSubscribed));
    r.on('trackUnsubscribed', live(onUnsubscribed));
    r.on(
      'participantDisconnected',
      live((participant: { identity: string }) => {
        remotes.delete(participant.identity);
      })
    );
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
      await r.connect(access.url, access.token, { autoSubscribe: true });
    } catch (err) {
      console.warn('livekit connect failed', err);
      if (r === room) {
        room = null;
        retry();
      }
      return;
    }
    if (r !== room || closed) {
      void r.disconnect(false);
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
    close() {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      const r = room;
      room = null;
      connected = false;
      remotes.clear();
      void r?.disconnect(false);
    },
    setAccess(next) {
      access = next;
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
