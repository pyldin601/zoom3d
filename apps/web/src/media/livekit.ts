// MediaTransport over the LiveKit SFU (LiveKit spec §4): our face (in three sizes), mic and boombox are published
// once, by name. We subscribe to others' tracks ourselves, per peer, as the interest rule wants them (6c spec §4.3),
// and dynacast pauses any of our face sizes nobody receives.
// Local tracks are user-provided: LocalMediaController owns them, so they are swapped with replaceTrack and LiveKit
// must never stop them (stopLocalTrackOnUnpublish: false, disconnect(false)), nor decide whether they are enabled:
// it rewrites `enabled` on publish and replace, and mutes a publication whose track ended, so both are undone.
// livekit-client itself is loaded with import() on first connect, keeping it out of the lobby bundle.

import type { LiveKitAccess } from '@zoom3d/shared';
import type { RoomConnectOptions, RoomOptions, TrackPublishOptions } from 'livekit-client';
import { type VideoWant, WANT_NONE, type Want } from './interest';
import type { FacesSent, FaceTracks, MediaTransport, TransportOptions } from './transport';

export const VIDEO_MAX_BITRATE = 350_000;
export const FACE_128_MAX_BITRATE = 120_000;
export const FACE_64_MAX_BITRATE = 35_000;
/** Mono music: transparent at this rate, well above Opus's ~32 kbps speech default (boombox spec §5.3). */
export const BOOMBOX_MAX_BITRATE = 64_000;
/** Firefox can't switch an encoding off, so for a paused size LiveKit lowers it to this bitrate (and 2 fps) instead. */
const FIREFOX_PAUSED_BITRATE = 10;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

type FaceName = 'face' | 'face-128' | 'face-64';
type TrackName = FaceName | 'mic' | 'boombox';

/** livekit-client's LocalTrack: unlike its publication, it survives a republish (signal restart). */
interface LocalTrackLike {
  mediaStreamTrack: MediaStreamTrack;
  isMuted: boolean;
  sender?: Pick<RTCRtpSender, 'getParameters' | 'setParameters'>;
  replaceTrack(track: MediaStreamTrack, options: { userProvidedTrack: boolean }): Promise<unknown>;
  unmute(): Promise<unknown>;
}

interface RemoteTrackLike {
  mediaStreamTrack: MediaStreamTrack;
  getRTCStatsReport(): Promise<RTCStatsReport | undefined>;
}

interface RemotePublicationLike {
  trackName: string;
  setSubscribed(subscribed: boolean): void;
}

interface RemoteParticipantLike {
  identity: string;
  trackPublications: Map<string, RemotePublicationLike>;
}

/** The part of livekit-client's Room this transport uses; tests pass a fake. */
export interface LiveKitRoomLike {
  remoteParticipants: Map<string, RemoteParticipantLike>;
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
    videoEncoding: { maxBitrate: VIDEO_MAX_BITRATE, maxFramerate: 24 },
  },
  // Separate tracks, not simulcast layers: livekit-client turns simulcast off below 480 px (6c spec §2).
  'face-128': {
    name: 'face-128',
    source: 'unknown' as TrackPublishOptions['source'],
    simulcast: false,
    videoEncoding: { maxBitrate: FACE_128_MAX_BITRATE, maxFramerate: 24 },
  },
  'face-64': {
    name: 'face-64',
    source: 'unknown' as TrackPublishOptions['source'],
    simulcast: false,
    videoEncoding: { maxBitrate: FACE_64_MAX_BITRATE, maxFramerate: 15 },
  },
  mic: { name: 'mic', source: 'microphone' as TrackPublishOptions['source'], dtx: true },
  boombox: {
    name: 'boombox',
    source: 'screen_share_audio' as TrackPublishOptions['source'],
    audioPreset: { maxBitrate: BOOMBOX_MAX_BITRATE },
    // Mono everywhere: Safari reports a stereo channelCount, which would make LiveKit send stereo Opus.
    forceStereo: false,
    dtx: false,
    red: false,
  },
};
const NAMES: TrackName[] = ['face', 'face-128', 'face-64', 'mic', 'boombox'];
const FACE_NAMES: FaceName[] = ['face', 'face-128', 'face-64'];
/** Per wanted size, the face tracks to try, nearest first (bigger before smaller on a tie). */
const FACE_ORDER: Record<Exclude<VideoWant, 'off'>, FaceName[]> = {
  256: ['face', 'face-128', 'face-64'],
  128: ['face-128', 'face', 'face-64'],
  64: ['face-64', 'face-128', 'face'],
};
/** The small faces' target sizes: fed the raw camera (hidden tab), their encoder scales it down. */
const SMALL_SIZE: Partial<Record<TrackName, number>> = { 'face-128': 128, 'face-64': 64 };

/**
 * Whether a published face goes out: dynacast switches its one encoding off while nobody receives it (LiveKit's
 * setPublishingLayers, from the SFU's subscribed qualities), or in Firefox turns it down to FIREFOX_PAUSED_BITRATE.
 */
function goesOut(lt: LocalTrackLike | null): boolean {
  const encoding = lt?.sender?.getParameters().encodings?.[0];
  return !!encoding && encoding.active !== false && (encoding.maxBitrate ?? Infinity) > FIREFOX_PAUSED_BITRATE;
}

/** One remote participant in the current room. */
interface Remote {
  /** Their publications, by track name. */
  pubs: Map<string, RemotePublicationLike>;
  /** Subscribed tracks, by track name. */
  tracks: Map<string, RemoteTrackLike>;
  /** What we asked LiveKit for, by track name. */
  asked: Map<string, boolean>;
  /** The face track we show (emitted in their stream). */
  face: FaceName | null;
  /** The face and mic tracks last emitted, so unchanged streams aren't re-emitted. */
  emittedFace: MediaStreamTrack | null;
  emittedMic: MediaStreamTrack | null;
}

const defaultLoadRoom = async () =>
  (await import('livekit-client')).Room as unknown as NonNullable<LiveKitTransportOptions['RoomImpl']>;

export function createLiveKitTransport(opts: LiveKitTransportOptions): MediaTransport {
  const createStream = opts.createStream ?? ((tracks: MediaStreamTrack[]) => new MediaStream(tracks));
  const local = opts.localStream;
  /** Our tracks, by the name each is published under; null for one we don't send. */
  const toPublish: Record<TrackName, MediaStreamTrack | null> = {
    face: local?.getVideoTracks()[0] ?? null,
    'face-128': null,
    'face-64': null,
    mic: local?.getAudioTracks()[0] ?? null,
    boombox: null,
  };
  const noTracksPublished = (): Record<TrackName, LocalTrackLike | null> => ({
    face: null,
    'face-128': null,
    'face-64': null,
    mic: null,
    boombox: null,
  });
  let access: LiveKitAccess = { url: opts.url, token: opts.token };
  let publishedTracks = noTracksPublished();
  /** What the interest rule wants from each peer; kept across rooms. */
  const wantedFrom = new Map<string, Want>();
  const remotes = new Map<string, Remote>();
  let room: LiveKitRoomLike | null = null;
  let connected = false;
  let closed = false;
  let retryMs = RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** A publish pass that failed for some track tries again after this, doubling up to RETRY_MAX_MS. */
  let republishMs = RETRY_MIN_MS;
  let republishTimer: ReturnType<typeof setTimeout> | null = null;
  // Publishing is serialized: every change runs one pass bringing what is published in line with toPublish.
  let publishQueue = Promise.resolve();

  /**
   * False when one track failed. Each track is tried on its own, so a face that times out doesn't keep the mic from
   * going out.
   */
  async function publishEveryTrack(lkRoom: LiveKitRoomLike): Promise<boolean> {
    // This room's record, even if a newer room replaces `publishedTracks` while a call is pending.
    const record = publishedTracks;
    let ok = true;
    for (const name of NAMES) {
      if (lkRoom !== room || closed) {
        return true;
      }
      try {
        await publishTrackAsWanted(lkRoom, record, name);
      } catch (err) {
        console.warn(`livekit publish of ${name} failed`, err);
        ok = false;
      }
    }
    return ok;
  }

  async function publishTrackAsWanted(lkRoom: LiveKitRoomLike, record: typeof publishedTracks, name: TrackName) {
    const want = toPublish[name];
    let localTrack = record[name];
    if (!want) {
      if (localTrack) {
        await lkRoom.localParticipant.unpublishTrack(localTrack, false);
      }
      record[name] = null;
      return;
    }
    if (localTrack?.mediaStreamTrack === want) {
      return;
    }
    const enabled = want.enabled;
    try {
      if (localTrack) {
        await localTrack.replaceTrack(want, { userProvidedTrack: true });
      } else {
        localTrack = (await lkRoom.localParticipant.publishTrack(want, PUBLISH[name])).track ?? null;
        record[name] = localTrack;
      }
      // Undo LiveKit's say over the track: unmute a publication it muted (its old track ended)...
      if (localTrack?.isMuted) {
        await localTrack.unmute();
      }
    } finally {
      // ...and keep the controller's mute, also when LiveKit failed half-way: a muted mic must stay silent.
      want.enabled = enabled;
    }
    const size = SMALL_SIZE[name];
    if (localTrack && size) {
      await scaleTo(localTrack, want, size);
    }
  }

  /** A small face fed a bigger track (the raw camera) scales it down to `size` on its shortest side. */
  async function scaleTo(localTrack: LocalTrackLike, track: MediaStreamTrack, size: number) {
    const sender = localTrack.sender;
    if (!sender) {
      return;
    }
    const settings = track.getSettings?.() ?? {};
    const side = Math.min(settings.width ?? size, settings.height ?? size);
    const scale = Math.max(1, side / size);
    const params = sender.getParameters();
    const encoding = params.encodings?.[0];
    if (!encoding || (encoding.scaleResolutionDownBy ?? 1) === scale) {
      return;
    }
    encoding.scaleResolutionDownBy = scale;
    await sender.setParameters(params);
  }

  const queuePublish = () => {
    publishQueue = publishQueue
      .then(async () => {
        const lkRoom = room;
        if (!lkRoom || !connected) {
          return;
        }
        if (await publishEveryTrack(lkRoom)) {
          republishMs = RETRY_MIN_MS;
        } else {
          retryPublishLater();
        }
      })
      .catch((err) => console.warn('livekit publish failed', err));
  };

  /** Nothing else re-runs a failed publish until a track changes, which may be never: retry on a timer. */
  const retryPublishLater = () => {
    if (closed || republishTimer !== null) {
      return;
    }
    republishTimer = setTimeout(() => {
      republishTimer = null;
      queuePublish();
    }, republishMs);
    republishMs = Math.min(republishMs * 2, RETRY_MAX_MS);
  };

  const remoteOf = (identity: string): Remote => {
    let remote = remotes.get(identity);
    if (!remote) {
      remote = {
        pubs: new Map(),
        tracks: new Map(),
        asked: new Map(),
        face: null,
        emittedFace: null,
        emittedMic: null,
      };
      remotes.set(identity, remote);
    }
    return remote;
  };

  /**
   * The shown face and the mic, each as its own new stream when its track changed (empty when gone): the audio
   * engine rebuilds a voice for every new stream object, so a face change must never re-emit the voice.
   */
  const emitStreams = (identity: string, remote: Remote) => {
    const face = remote.face ? (remote.tracks.get(remote.face)?.mediaStreamTrack ?? null) : null;
    const mic = remote.tracks.get('mic')?.mediaStreamTrack ?? null;
    if (face !== remote.emittedFace) {
      remote.emittedFace = face;
      opts.onRemoteStream(identity, createStream(face ? [face] : []));
    }
    if (mic !== remote.emittedMic) {
      remote.emittedMic = mic;
      opts.onRemoteVoice(identity, createStream(mic ? [mic] : []));
    }
  };

  const askFor = (remote: Remote, name: string, on: boolean) => {
    const pub = remote.pubs.get(name);
    if (pub && (remote.asked.get(name) ?? false) !== on) {
      remote.asked.set(name, on);
      pub.setSubscribed(on);
    }
  };

  /**
   * Subscribes to what the peer's want asks for. A size switch is make-before-break: the shown face stays
   * subscribed until the new size's track has arrived, then the stream swaps and the old one is dropped.
   */
  const subscribeAsWanted = (identity: string) => {
    const remote = remotes.get(identity);
    if (!remote) {
      return;
    }
    const want = wantedFrom.get(identity) ?? WANT_NONE;
    const target = want.video === 'off' ? null : (FACE_ORDER[want.video].find((n) => remote.pubs.has(n)) ?? null);
    if (target === null || remote.tracks.has(target)) {
      remote.face = target;
    }
    for (const name of FACE_NAMES) {
      askFor(remote, name, name === target || name === remote.face);
    }
    askFor(remote, 'mic', want.audio);
    askFor(remote, 'boombox', want.audio);
    emitStreams(identity, remote);
  };

  const onPublished = (pub: RemotePublicationLike, participant: { identity: string }) => {
    remoteOf(participant.identity).pubs.set(pub.trackName, pub);
    subscribeAsWanted(participant.identity);
  };

  const onUnpublished = (pub: RemotePublicationLike, participant: { identity: string }) => {
    const remote = remotes.get(participant.identity);
    remote?.pubs.delete(pub.trackName);
    remote?.asked.delete(pub.trackName);
    subscribeAsWanted(participant.identity);
  };

  const onSubscribed = (track: RemoteTrackLike, pub: RemotePublicationLike, participant: { identity: string }) => {
    const { identity } = participant;
    const remote = remoteOf(identity);
    remote.tracks.set(pub.trackName, track);
    // It is subscribed now, whatever we asked last: subscribeAsWanted() drops it again if it's no longer wanted.
    remote.asked.set(pub.trackName, true);
    if (pub.trackName === 'boombox') {
      opts.onRemoteBoombox(identity, createStream([track.mediaStreamTrack]));
    }
    subscribeAsWanted(identity);
  };

  const onUnsubscribed = (_track: RemoteTrackLike, pub: RemotePublicationLike, participant: { identity: string }) => {
    const remote = remotes.get(participant.identity);
    if (!remote) {
      return;
    }
    remote.tracks.delete(pub.trackName);
    remote.asked.delete(pub.trackName);
    if (remote.face === pub.trackName) {
      remote.face = null;
    }
    subscribeAsWanted(participant.identity);
  };

  const retry = () => {
    if (closed) {
      return;
    }
    retryTimer = setTimeout(() => void start(), retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  /** Joins a fresh LiveKit room: loads livekit-client, listens to the room, connects, then catches up. */
  async function start() {
    retryTimer = null;
    if (closed) {
      return;
    }
    const RoomClass = await loadRoomClass();
    if (!RoomClass || closed) {
      return;
    }
    const lkRoom = new RoomClass({ adaptiveStream: false, dynacast: true, stopLocalTrackOnUnpublish: false });
    room = lkRoom;
    connected = false;
    publishedTracks = noTracksPublished();
    remotes.clear();
    listenTo(lkRoom);
    if (!(await connectTo(lkRoom))) {
      return;
    }
    connected = true;
    retryMs = RETRY_MIN_MS;
    catchUpWithParticipants(lkRoom);
    queuePublish();
  }

  /** Undefined when loading failed, a retry already scheduled. */
  async function loadRoomClass(): Promise<LiveKitTransportOptions['RoomImpl']> {
    try {
      return opts.RoomImpl ?? (await (opts.loadRoom ?? defaultLoadRoom)());
    } catch (err) {
      // E.g. a tab older than a deploy asks for a chunk that's gone: retrying beats a silent room.
      console.warn('livekit-client failed to load', err);
      retry();
      return undefined;
    }
  }

  function listenTo(lkRoom: LiveKitRoomLike): void {
    /** Events from a room that was closed or replaced must not touch the current one's media. */
    const whileCurrent = <A extends unknown[]>(fn: (...args: A) => void) =>
      ((...args: A) => {
        if (lkRoom === room && !closed) {
          fn(...args);
        }
      }) as unknown as (...args: never[]) => void;
    lkRoom.on('trackPublished', whileCurrent(onPublished));
    lkRoom.on('trackUnpublished', whileCurrent(onUnpublished));
    lkRoom.on('trackSubscribed', whileCurrent(onSubscribed));
    lkRoom.on('trackUnsubscribed', whileCurrent(onUnsubscribed));
    lkRoom.on(
      'participantDisconnected',
      whileCurrent((participant: { identity: string }) => {
        remotes.delete(participant.identity);
      })
    );
    // LiveKit gave up reconnecting (or the server went away): start over with a fresh room.
    lkRoom.on('disconnected', () => {
      if (lkRoom !== room || closed) {
        return;
      }
      room = null;
      connected = false;
      remotes.clear();
      retry();
    });
  }

  /** False when it failed (then a retry is scheduled) or the room was replaced or closed meanwhile. */
  async function connectTo(lkRoom: LiveKitRoomLike): Promise<boolean> {
    try {
      await lkRoom.connect(access.url, access.token, { autoSubscribe: false });
    } catch (err) {
      console.warn('livekit connect failed', err);
      if (lkRoom === room) {
        room = null;
        retry();
      }
      return false;
    }
    if (lkRoom !== room || closed) {
      void lkRoom.disconnect(false);
      return false;
    }
    return true;
  }

  /** Participants already here when we joined get no trackPublished. */
  function catchUpWithParticipants(lkRoom: LiveKitRoomLike): void {
    for (const participant of lkRoom.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        onPublished(pub, participant);
      }
    }
  }

  void start();

  return {
    close() {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (republishTimer) {
        clearTimeout(republishTimer);
      }
      const leaving = room;
      room = null;
      connected = false;
      remotes.clear();
      void leaving?.disconnect(false);
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
      for (const [name, track] of tracks.tracks) {
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
    setVideoTracks(tracks: FaceTracks) {
      toPublish.face = tracks[256];
      toPublish['face-128'] = tracks[128];
      toPublish['face-64'] = tracks[64];
      queuePublish();
    },
    sendingFaces(): FacesSent {
      const sending = connected && !closed;
      return {
        256: sending && goesOut(publishedTracks.face),
        128: sending && goesOut(publishedTracks['face-128']),
        64: sending && goesOut(publishedTracks['face-64']),
      };
    },
    publishes: (peerId) => (remotes.get(peerId)?.pubs.size ?? 0) > 0,
    setWanted(peerId, want) {
      wantedFrom.set(peerId, want);
      subscribeAsWanted(peerId);
    },
    setAudioTrack(track) {
      toPublish.mic = track;
      queuePublish();
    },
    setBoomboxTrack(track) {
      toPublish.boombox = track;
      queuePublish();
    },
  };
}
