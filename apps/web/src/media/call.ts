// Glue between the session (presence) and media: the LiveKit transport, remote elements, faces.
import type { PeerInfo } from '@zoom3d/shared';
import type { AudioEngine } from '../audio/engine';
import type { Session, SessionListener } from '../net/session';
import type { createFace as CreateFace, FaceSource } from './faces';
import type { LocalMediaController } from './local-media';
import type { RemoteMedia } from './remote-media';
import type { MediaTransport, TransportOptions } from './transport';

export interface Call {
  /** Pass to createSession, then call attach() with the session. */
  listener: SessionListener;
  attach(session: Session): void;
  faceOf(peerId: string): Uint32Array | null;
  isLive(peerId: string): boolean;
  stats(peerId: string): Promise<{ bytesReceived: number; boomboxBytesReceived: number } | null>;
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

/** Engine and element key of a peer's boombox music (boombox spec §4). */
export const boomboxKey = (peerId: string) => `boombox:${peerId}`;

export function createCall(opts: CallOptions): Call {
  const { local, remote } = opts;
  const faces = new Map<string, FaceSource>();
  const state = { cam: local.state().cam, mic: local.state().mic };
  let session: Session | null = null;
  let transport: MediaTransport | null = null;
  let boomboxTrack: MediaStreamTrack | null = null;
  const { framer } = local;
  // The canvas track is always sent, so camera on/off never renegotiates (lobby spec §4.3).
  framer.onSendTrackChange = () => transport?.setVideoTracks(framer.sendTracks());

  /** Media LiveKit delivered before the game announced its peer (it is never sent again). */
  const early = new Map<string, { stream?: MediaStream; boombox?: MediaStream }>();

  const applyStream = (peerId: string, stream: MediaStream) => {
    faces.get(peerId)?.setVideo(remote.attach(peerId, stream));
    opts.audio?.attach(peerId, stream);
  };

  const applyBoombox = (peerId: string, stream: MediaStream) => {
    const key = boomboxKey(peerId);
    remote.attachAudio(key, stream);
    opts.audio?.attach(key, stream, peerId);
  };

  const ensureFace = (peer: PeerInfo) => {
    let face = faces.get(peer.id);
    if (!face) {
      face = opts.createFace({
        name: peer.name,
        color: peer.color,
        avatar: peer.avatar,
        document: opts.document,
      });
      faces.set(peer.id, face);
      const pending = early.get(peer.id);
      early.delete(peer.id);
      if (pending?.stream) {
        applyStream(peer.id, pending.stream);
      }
      if (pending?.boombox) {
        applyBoombox(peer.id, pending.boombox);
      }
    }
    face.setCam(peer.cam);
  };

  const drop = (peerId: string) => {
    remote.detach(peerId);
    remote.detach(boomboxKey(peerId));
    opts.audio?.detach(peerId);
    opts.audio?.detach(boomboxKey(peerId));
    faces.get(peerId)?.dispose();
    faces.delete(peerId);
    early.delete(peerId);
  };

  const teardown = () => {
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

  const publish = () => session?.setMedia(state.cam, state.mic);

  /** Picks up the controller's state, publishing only when it changed (a camera restart, an unplugged mic). */
  let micTrack = local.micTrack();
  const sync = () => {
    // A replaced mic (unplugged headset) must reach senders that already exist.
    const track = local.micTrack();
    if (track !== micTrack) {
      micTrack = track;
      if (track) {
        transport?.setAudioTrack(track);
      }
    }
    const { cam, mic } = local.state();
    if (cam !== state.cam || mic !== state.mic) {
      state.cam = cam;
      state.mic = mic;
      publish();
    }
  };
  const unsubscribe = local.subscribe(sync);

  const listener: SessionListener = {
    welcome(_selfId, livekit, identityChanged) {
      // A resume keeps the transport (LiveKit reconnects by itself); only a new identity needs a new one.
      if (identityChanged || !transport) {
        teardown();
        transport = opts.createTransport({
          url: livekit.url,
          token: livekit.token,
          localStream: local.stream,
          onRemoteStream: (peerId, stream) => {
            if (faces.has(peerId)) {
              applyStream(peerId, stream);
            } else {
              early.set(peerId, { ...early.get(peerId), stream });
            }
          },
          onRemoteBoombox: (peerId, stream) => {
            if (faces.has(peerId)) {
              applyBoombox(peerId, stream);
            } else {
              early.set(peerId, { ...early.get(peerId), boombox: stream });
            }
          },
        });
        transport.setBoomboxTrack(boomboxTrack);
        // The tab may already be hidden, in which case peers get the raw camera track.
        transport.setVideoTracks(framer.sendTracks());
      } else {
        // A resume's fresh token: LiveKit's own reconnects outlast the first one's 6 h.
        transport.setAccess(livekit);
      }
      const present = session?.peers ?? new Map();
      for (const id of [...faces.keys()]) {
        if (!present.has(id)) {
          drop(id);
        }
      }
      for (const peer of present.values()) {
        ensureFace(peer.info);
      }
    },
    peerJoined(peer) {
      ensureFace(peer);
    },
    peerLeft: drop,
    peerMedia(id, cam) {
      faces.get(id)?.setCam(cam);
    },
  };

  return {
    listener,
    attach(s) {
      session = s;
      publish();
    },
    faceOf: (id) => faces.get(id)?.texels ?? null,
    isLive: (id) => faces.get(id)?.live() ?? false,
    stats: async (id) => (transport ? transport.stats(id) : null),
    setBoomboxTrack(track) {
      boomboxTrack = track;
      transport?.setBoomboxTrack(track);
    },
    async setCam(on) {
      await local.setCam(on);
      sync();
      return state.cam;
    },
    setMic(on) {
      local.setMic(on);
      sync();
      return state.mic;
    },
    localState: () => ({ ...state }),
    update(now) {
      for (const face of faces.values()) {
        face.update(now);
      }
    },
    dispose() {
      unsubscribe();
      teardown();
    },
  };
}
