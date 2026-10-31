// Glue between the session (presence) and media: the LiveKit transport, remote elements, faces.
import { avatarPath, type LiveKitAccess, type PeerInfo } from '@zoom3d/shared';
import type { AudioEngine } from '../audio/engine';
import type { Session, SessionListener } from '../net/session';
import type { createFace as CreateFace, FaceSource } from './faces';
import { WANT_NONE, type Want } from './interest';
import type { LocalMediaController } from './local-media';
import type { RemoteMedia } from './remote-media';
import { type FacesSent, type MediaTransport, NO_FACES_SENT, type TransportOptions } from './transport';

export interface Call {
  /** Pass to createSession, then call attach() with the session. */
  listener: SessionListener;
  attach(session: Session): void;
  faceOf(peerId: string): Uint32Array | null;
  isLive(peerId: string): boolean;
  stats(peerId: string): Promise<{ bytesReceived: number; boomboxBytesReceived: number } | null>;
  /** Which of our face sizes someone receives now; none before the media room is up. */
  sendingFaces(): FacesSent;
  /** Whether the peer publishes media at all (people do, bots don't). */
  publishes(peerId: string): boolean;
  /** What to receive from a peer (the interest rule's output); kept across a recreated transport. */
  setWanted(peerId: string, want: Want): void;
  /** Our boombox music, or null when it is off; kept across a recreated transport. */
  setBoomboxTrack(track: MediaStreamTrack | null): void;
  /** Stops or restarts the camera; resolves to whether it is on now. */
  setCam(on: boolean): Promise<boolean>;
  /** Mutes or unmutes; returns whether the mic is on now. */
  setMic(on: boolean): boolean;
  localState(): { cam: boolean; mic: boolean };
  update(now: number): void;
  dispose(): void;
}

export interface CallOptions {
  local: LocalMediaController;
  remote: RemoteMedia;
  /** Spatial voice engine; remote audio plays only through it. */
  audio: Pick<AudioEngine, 'attach' | 'detach'> | null;
  document: Document;
  createFace: typeof CreateFace;
  createTransport: (opts: TransportOptions) => MediaTransport;
}

/** A peer's face, voice and boombox streams, each as last delivered. */
interface EarlyMedia {
  stream?: MediaStream;
  voice?: MediaStream;
  boombox?: MediaStream;
}

/** Engine and element key of a peer's boombox music (boombox spec §4). */
export const boomboxKey = (peerId: string) => `boombox:${peerId}`;
/** Element key of a peer's voice; the engine keys it by the peer id itself. */
export const voiceKey = (peerId: string) => `voice:${peerId}`;

export function createCall(opts: CallOptions): Call {
  const { local, remote } = opts;
  const faces = new Map<string, FaceSource>();
  const wantedFrom = new Map<string, Want>();
  /** The local camera and mic as last told to the session. */
  const ownMedia = { cam: local.state().cam, mic: local.state().mic };
  let session: Session | null = null;
  let transport: MediaTransport | null = null;
  let boomboxTrack: MediaStreamTrack | null = null;
  const { framer } = local;
  // The canvas track is always sent, so camera on/off never renegotiates (lobby spec §4.3).
  framer.onSendTrackChange = () => transport?.setVideoTracks(framer.sendTracks());

  /** Media LiveKit delivered before the game announced its peer (it is never sent again). */
  const early = new Map<string, EarlyMedia>();
  /** Keeps a stream for a peer not announced yet; an emptied one (their track went) just drops what was kept. */
  const keepEarly = (peerId: string, kind: keyof EarlyMedia, stream: MediaStream) => {
    const kept = early.get(peerId) ?? {};
    kept[kind] = stream.getTracks().length > 0 ? stream : undefined;
    if (kept.stream || kept.voice || kept.boombox) {
      early.set(peerId, kept);
    } else {
      early.delete(peerId);
    }
  };

  const applyStream = (peerId: string, stream: MediaStream) => {
    faces.get(peerId)?.setVideo(remote.attach(peerId, stream));
  };

  /** The voice has its own element and stream, so face changes (6c) never rebuild it in the engine. */
  const applyVoice = (peerId: string, stream: MediaStream) => {
    remote.attachAudio(voiceKey(peerId), stream);
    opts.audio?.attach(peerId, stream);
  };

  const applyBoombox = (peerId: string, stream: MediaStream) => {
    const key = boomboxKey(peerId);
    remote.attachAudio(key, stream);
    opts.audio?.attach(key, stream, peerId);
  };

  const ensureFace = (peer: PeerInfo) => {
    const face = faces.get(peer.id) ?? createPeerFace(peer);
    face.setCam(peer.cam);
  };

  const createPeerFace = (peer: PeerInfo): FaceSource => {
    const face = opts.createFace({
      name: peer.name,
      color: peer.color,
      avatar: peer.avatar === null ? null : avatarPath(peer.avatar),
      document: opts.document,
    });
    faces.set(peer.id, face);
    const want = wantedFrom.get(peer.id);
    if (want) {
      face.setPaused(want.video === 'off');
    }
    applyEarlyMedia(peer.id);
    return face;
  };

  const applyEarlyMedia = (peerId: string) => {
    const kept = early.get(peerId);
    early.delete(peerId);
    if (kept?.stream) {
      applyStream(peerId, kept.stream);
    }
    if (kept?.voice) {
      applyVoice(peerId, kept.voice);
    }
    if (kept?.boombox) {
      applyBoombox(peerId, kept.boombox);
    }
  };

  const forgetPeer = (peerId: string) => {
    // Gone from the game but maybe still in the media room (a dropped game connection): stop receiving them.
    transport?.setWanted(peerId, WANT_NONE);
    remote.detach(peerId);
    remote.detach(voiceKey(peerId));
    remote.detach(boomboxKey(peerId));
    opts.audio?.detach(peerId);
    opts.audio?.detach(boomboxKey(peerId));
    faces.get(peerId)?.dispose();
    faces.delete(peerId);
    early.delete(peerId);
    wantedFrom.delete(peerId);
  };

  /** Closes the transport and forgets every peer's media. */
  const closeTransport = () => {
    transport?.close();
    transport = null;
    early.clear();
    remote.detachAll();
    for (const id of faces.keys()) {
      opts.audio?.detach(id);
      opts.audio?.detach(boomboxKey(id));
    }
    for (const face of faces.values()) {
      face.dispose();
    }
    faces.clear();
  };

  const tellSessionOwnMedia = () => session?.setMedia(ownMedia.cam, ownMedia.mic);

  let micTrack = local.micTrack();
  /** Picks up the controller's state, publishing only when it changed (a camera restart, an unplugged mic). */
  const followLocalMedia = () => {
    // A replaced mic (unplugged headset) must reach senders that already exist.
    const track = local.micTrack();
    if (track !== micTrack) {
      micTrack = track;
      if (track) {
        transport?.setAudioTrack(track);
      }
    }
    const { cam, mic } = local.state();
    if (cam !== ownMedia.cam || mic !== ownMedia.mic) {
      ownMedia.cam = cam;
      ownMedia.mic = mic;
      tellSessionOwnMedia();
    }
  };
  const unsubscribe = local.subscribe(followLocalMedia);

  const openTransport = (livekit: LiveKitAccess) => {
    closeTransport();
    const opened = opts.createTransport({
      url: livekit.url,
      token: livekit.token,
      localStream: local.stream,
      onRemoteStream: (peerId, stream) =>
        faces.has(peerId) ? applyStream(peerId, stream) : keepEarly(peerId, 'stream', stream),
      onRemoteVoice: (peerId, stream) =>
        faces.has(peerId) ? applyVoice(peerId, stream) : keepEarly(peerId, 'voice', stream),
      onRemoteBoombox: (peerId, stream) =>
        faces.has(peerId) ? applyBoombox(peerId, stream) : keepEarly(peerId, 'boombox', stream),
    });
    transport = opened;
    opened.setBoomboxTrack(boomboxTrack);
    // The tab may already be hidden, in which case peers get the raw camera track.
    opened.setVideoTracks(framer.sendTracks());
    for (const [id, want] of wantedFrom) {
      opened.setWanted(id, want);
    }
  };

  /** A face for everyone the session has, and none for anyone it doesn't. */
  const matchFacesToPeers = () => {
    const present = session?.peers ?? new Map();
    for (const id of [...faces.keys()]) {
      if (!present.has(id)) {
        forgetPeer(id);
      }
    }
    for (const peer of present.values()) {
      ensureFace(peer.info);
    }
  };

  const listener: SessionListener = {
    welcome(_selfId, livekit, identityChanged) {
      // A resume keeps the transport (LiveKit reconnects by itself); only a new identity needs a new one.
      if (identityChanged || !transport) {
        openTransport(livekit);
      } else {
        // A resume's fresh token: LiveKit's own reconnects outlast the first one's 6 h.
        transport.setAccess(livekit);
      }
      matchFacesToPeers();
    },
    peerJoined(peer) {
      ensureFace(peer);
    },
    peerLeft: forgetPeer,
    peerMedia(id, cam) {
      faces.get(id)?.setCam(cam);
    },
  };

  return {
    listener,
    attach(s) {
      session = s;
      tellSessionOwnMedia();
    },
    faceOf: (id) => faces.get(id)?.texels ?? null,
    isLive: (id) => faces.get(id)?.live() ?? false,
    stats: async (id) => (transport ? transport.stats(id) : null),
    sendingFaces: () => transport?.sendingFaces() ?? NO_FACES_SENT,
    publishes: (id) => transport?.publishes(id) ?? false,
    setWanted(peerId, want) {
      wantedFrom.set(peerId, want);
      transport?.setWanted(peerId, want);
      faces.get(peerId)?.setPaused(want.video === 'off');
    },
    setBoomboxTrack(track) {
      boomboxTrack = track;
      transport?.setBoomboxTrack(track);
    },
    async setCam(on) {
      await local.setCam(on);
      followLocalMedia();
      return ownMedia.cam;
    },
    setMic(on) {
      local.setMic(on);
      followLocalMedia();
      return ownMedia.mic;
    },
    localState: () => ({ ...ownMedia }),
    update(now) {
      for (const face of faces.values()) {
        face.update(now);
      }
    },
    dispose() {
      unsubscribe();
      closeTransport();
    },
  };
}
