// Glue between the session (signalling, presence) and media: mesh connections, remote elements, faces.
import type { PeerInfo } from '@zoom3d/shared';
import type { AudioEngine } from '../audio/engine';
import type { Session, SessionListener } from '../net/session';
import type { createFace as CreateFace, FaceSource } from './faces';
import type { LocalMediaController } from './local-media';
import type { createMesh as CreateMesh, MediaTransport } from './mesh';
import type { RemoteMedia } from './remote-media';

export interface Call {
  /** Pass to createSession, then call attach() with the session. */
  listener: SessionListener;
  attach(session: Session): void;
  faceOf(peerId: string): Uint32Array | null;
  isLive(peerId: string): boolean;
  stats(peerId: string): Promise<{ bytesReceived: number; boomboxBytesReceived: number } | null>;
  /** Our boombox music, or null when it is off; kept across a recreated mesh. */
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
  createMesh: typeof CreateMesh;
}

/** Engine and element key of a peer's boombox music (boombox spec §4). */
export const boomboxKey = (peerId: string) => `boombox:${peerId}`;

export function createCall(opts: CallOptions): Call {
  const { local, remote } = opts;
  const faces = new Map<string, FaceSource>();
  const state = { cam: local.state().cam, mic: local.state().mic };
  let session: Session | null = null;
  let mesh: MediaTransport | null = null;
  let boomboxTrack: MediaStreamTrack | null = null;
  const { framer } = local;
  // The canvas track is always sent, so camera on/off never renegotiates (lobby spec §4.3).
  framer.onSendTrackChange = () => mesh?.setVideoTrack(framer.sendTrack);

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
    }
    face.setCam(peer.cam);
  };

  const drop = (peerId: string) => {
    mesh?.disconnect(peerId);
    remote.detach(peerId);
    remote.detach(boomboxKey(peerId));
    opts.audio?.detach(peerId);
    opts.audio?.detach(boomboxKey(peerId));
    faces.get(peerId)?.dispose();
    faces.delete(peerId);
  };

  const teardown = () => {
    mesh?.close();
    mesh = null;
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
        mesh?.setAudioTrack(track);
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
    welcome(selfId, iceServers, identityChanged) {
      if (identityChanged || !mesh) {
        teardown();
        mesh = opts.createMesh({
          selfId,
          iceServers,
          localStream: local.stream,
          sendSignal: (to, payload) => session?.sendSignal(to, payload),
          onRemoteStream: (peerId, stream) => {
            const face = faces.get(peerId);
            if (!face) {
              return;
            }
            face.setVideo(remote.attach(peerId, stream));
            opts.audio?.attach(peerId, stream);
          },
          onRemoteBoombox: (peerId, stream) => {
            if (!faces.has(peerId)) {
              return;
            }
            const key = boomboxKey(peerId);
            remote.attachAudio(key, stream);
            opts.audio?.attach(key, stream, peerId);
          },
        });
        mesh.setBoomboxTrack(boomboxTrack);
        // The tab may already be hidden, in which case peers get the raw camera track.
        mesh.setVideoTrack(framer.sendTrack);
      }
      const present = session?.peers ?? new Map();
      for (const id of [...faces.keys()]) {
        if (!present.has(id)) {
          drop(id);
        }
      }
      for (const peer of present.values()) {
        ensureFace(peer.info);
        mesh.connect(peer.info.id);
      }
    },
    peerJoined(peer) {
      ensureFace(peer);
      mesh?.connect(peer.id);
    },
    peerLeft: drop,
    peerMedia(id, cam) {
      faces.get(id)?.setCam(cam);
    },
    signal(from, payload) {
      void mesh?.handleSignal(from, payload);
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
    stats: async (id) => (mesh ? mesh.stats(id) : null),
    setBoomboxTrack(track) {
      boomboxTrack = track;
      mesh?.setBoomboxTrack(track);
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
