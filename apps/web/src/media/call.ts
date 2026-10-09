// Glue between the session (signalling, presence) and media: mesh connections, remote elements, faces.
import type { PeerInfo } from '@zoom3d/shared';
import type { AudioEngine } from '../audio/engine';
import type { Session, SessionListener } from '../net/session';
import type { LocalMedia } from './capture';
import type { createFace as CreateFace, FaceSource } from './faces';
import type { createMesh as CreateMesh, MediaTransport } from './mesh';
import type { RemoteMedia } from './remote-media';

export interface Call {
  /** Pass to createSession, then call attach() with the session. */
  listener: SessionListener;
  attach(session: Session): void;
  faceOf(peerId: string): Uint32Array | null;
  isLive(peerId: string): boolean;
  stats(peerId: string): Promise<{ bytesReceived: number } | null>;
  setCam(on: boolean): void;
  setMic(on: boolean): void;
  localState(): { cam: boolean; mic: boolean };
  update(now: number): void;
  dispose(): void;
}

export interface CallOptions {
  local: LocalMedia;
  remote: RemoteMedia;
  /** Spatial voice engine; remote audio plays only through it. */
  audio: Pick<AudioEngine, 'attach' | 'detach'> | null;
  document: Document;
  createFace: typeof CreateFace;
  createMesh: typeof CreateMesh;
}

export function createCall(opts: CallOptions): Call {
  const { local, remote } = opts;
  const faces = new Map<string, FaceSource>();
  const state = { cam: local.cam, mic: local.mic };
  let session: Session | null = null;
  let mesh: MediaTransport | null = null;

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
    opts.audio?.detach(peerId);
    faces.get(peerId)?.dispose();
    faces.delete(peerId);
  };

  const teardown = () => {
    mesh?.close();
    mesh = null;
    remote.detachAll();
    for (const id of faces.keys()) {
      opts.audio?.detach(id);
    }
    for (const face of faces.values()) {
      face.dispose();
    }
    faces.clear();
  };

  const publish = () => session?.setMedia(state.cam, state.mic);

  const setEnabled = (tracks: MediaStreamTrack[] | undefined, on: boolean) => {
    for (const t of tracks ?? []) {
      t.enabled = on;
    }
  };

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
        });
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
    setCam(on) {
      state.cam = on && local.cam;
      setEnabled(local.stream?.getVideoTracks(), state.cam);
      publish();
    },
    setMic(on) {
      state.mic = on && local.mic;
      setEnabled(local.stream?.getAudioTracks(), state.mic);
      publish();
    },
    localState: () => ({ ...state }),
    update(now) {
      for (const face of faces.values()) {
        face.update(now);
      }
    },
    dispose: teardown,
  };
}
