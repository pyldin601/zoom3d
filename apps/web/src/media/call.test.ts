import type { IceServer, PeerInfo, SignalPayload } from '@zoom3d/shared';
import { beforeEach, expect, test, vi } from 'vitest';
import type { AudioEngine } from '../audio/engine';
import type { RemotePeer, Session } from '../net/session';
import { createCall } from './call';
import type { FaceSource } from './faces';
import type { LocalMediaController } from './local-media';
import type { MeshOptions } from './mesh';
import type { RemoteMedia } from './remote-media';

const ICE: IceServer[] = [{ urls: ['stun:x'] }];
const info = (id: string, cam = true): PeerInfo => ({
  id,
  name: id,
  color: '#fff',
  x: 1,
  y: 1,
  angle: 0,
  cam,
  mic: true,
  avatar: null,
  held: null,
  boombox: false,
});

let meshes: {
  opts: MeshOptions;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  handleSignal: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setVideoTrack: ReturnType<typeof vi.fn>;
  setBoomboxTrack: ReturnType<typeof vi.fn>;
}[];
let faces: Map<string, FaceSource & { [k: string]: unknown }>;
let faceAvatars: Map<string, string | null | undefined>;
let session: Session;
let remote: {
  attach: ReturnType<typeof vi.fn>;
  attachAudio: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  detachAll: ReturnType<typeof vi.fn>;
};
let audio: { attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> };

function fakeFramer(sendTrack: unknown) {
  return { track: { id: 'canvas' }, sendTrack, onSendTrackChange: null as (() => void) | null };
}

/** A controller whose camera comes up only if `camWorks`. */
function fakeLocal(init: { cam?: boolean; mic?: boolean; camWorks?: boolean } = {}) {
  const state = { cam: init.cam ?? true, mic: init.mic ?? true };
  const subscribers = new Set<() => void>();
  const notify = () => {
    for (const fn of subscribers) {
      fn();
    }
  };
  return {
    state,
    framer: fakeFramer({ id: 'canvas' }),
    stream: { id: 'local' } as unknown as MediaStream,
    notify,
    controller: {
      state: () => ({
        ...state,
        camAvailable: true,
        micAvailable: true,
        camProblem: null,
        micProblem: null,
        pending: false,
      }),
      setCam: vi.fn(async (on: boolean) => {
        state.cam = on && (init.camWorks ?? true);
        notify();
      }),
      setMic: vi.fn((on: boolean) => {
        state.mic = on;
        notify();
      }),
      subscribe(fn: () => void) {
        subscribers.add(fn);
        return () => {
          subscribers.delete(fn);
        };
      },
    },
  };
}
let local: ReturnType<typeof fakeLocal>;

function setPeers(...peers: PeerInfo[]) {
  session.peers.clear();
  for (const p of peers) {
    session.peers.set(p.id, { info: p } as RemotePeer);
  }
}

function makeCall(init: Parameters<typeof fakeLocal>[0] = {}) {
  local = fakeLocal(init);
  const call = createCall({
    local: { ...local.controller, framer: local.framer, stream: local.stream } as unknown as LocalMediaController,
    remote: remote as unknown as RemoteMedia,
    audio: audio as unknown as Pick<AudioEngine, 'attach' | 'detach'>,
    document: {} as Document,
    createFace: ({ name, avatar }) => {
      faceAvatars.set(name, avatar);
      const face = {
        texels: new Uint32Array([name.length]),
        live: () => false,
        update: vi.fn(),
        setVideo: vi.fn(),
        setCam: vi.fn(),
        dispose: vi.fn(),
      };
      faces.set(name, face as never);
      return face;
    },
    createMesh: (opts) => {
      const mesh = {
        opts,
        connect: vi.fn(),
        disconnect: vi.fn(),
        handleSignal: vi.fn(async () => {}),
        close: vi.fn(),
        stats: vi.fn(async () => ({ bytesReceived: 5, boomboxBytesReceived: 2 })),
        setVideoTrack: vi.fn(),
        setBoomboxTrack: vi.fn(),
      };
      meshes.push(mesh);
      return mesh;
    },
  });
  call.attach(session);
  return call;
}

beforeEach(() => {
  meshes = [];
  faces = new Map();
  faceAvatars = new Map();
  remote = {
    attach: vi.fn(() => ({ id: 'video-el' })),
    attachAudio: vi.fn(),
    detach: vi.fn(),
    detachAll: vi.fn(),
  };
  audio = { attach: vi.fn(), detach: vi.fn() };
  session = {
    peers: new Map(),
    sendSignal: vi.fn(),
    setMedia: vi.fn(),
  } as unknown as Session;
});

test('attaching publishes the local media state', () => {
  makeCall({ cam: false, mic: true });
  expect(session.setMedia).toHaveBeenCalledWith(false, true);
});

test('a fresh welcome creates a mesh and connects every peer with a face', () => {
  const call = makeCall();
  setPeers(info('a'), info('b', false));
  call.listener.welcome?.('me', ICE, true);
  expect(meshes).toHaveLength(1);
  expect(meshes[0]?.opts).toMatchObject({ selfId: 'me', iceServers: ICE });
  expect(meshes[0]?.connect.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  expect(faces.get('b')?.setCam).toHaveBeenCalledWith(false);
  expect(call.faceOf('a')).toBe(faces.get('a')?.texels);
});

test("faces get the peer's avatar picture", () => {
  const call = makeCall();
  const pic = 'data:image/jpeg;base64,/9j/';
  setPeers({ ...info('a'), avatar: pic });
  call.listener.welcome?.('me', ICE, true);
  call.listener.peerJoined?.(info('b'));
  expect(faceAvatars.get('a')).toBe(pic);
  expect(faceAvatars.get('b')).toBeNull();
});

test('a resume keeps the mesh, connects newcomers and drops peers that are gone', () => {
  const call = makeCall();
  setPeers(info('a'), info('b'));
  call.listener.welcome?.('me', ICE, true);
  setPeers(info('b'), info('c'));
  call.listener.welcome?.('me', ICE, false);
  expect(meshes).toHaveLength(1);
  expect(meshes[0]?.connect.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'b', 'c']);
  expect(meshes[0]?.disconnect).toHaveBeenCalledWith('a');
  expect(faces.get('a')?.dispose).toHaveBeenCalled();
});

test('a new identity replaces the mesh entirely', () => {
  const call = makeCall();
  setPeers(info('a'));
  call.listener.welcome?.('me', ICE, true);
  call.listener.welcome?.('me2', ICE, true);
  expect(meshes[0]?.close).toHaveBeenCalled();
  expect(remote.detachAll).toHaveBeenCalled();
  expect(meshes[1]?.opts.selfId).toBe('me2');
});

test('peers joining and leaving are connected and cleaned up', () => {
  const call = makeCall();
  call.listener.welcome?.('me', ICE, true);
  call.listener.peerJoined?.(info('a'));
  expect(meshes[0]?.connect).toHaveBeenCalledWith('a');
  call.listener.peerLeft?.('a');
  expect(meshes[0]?.disconnect).toHaveBeenCalledWith('a');
  expect(remote.detach).toHaveBeenCalledWith('a');
  expect(faces.get('a')?.dispose).toHaveBeenCalled();
  expect(call.faceOf('a')).toBeNull();
});

test('signals go to the mesh; outgoing signals go through the session', () => {
  const call = makeCall();
  call.listener.welcome?.('me', ICE, true);
  const payload: SignalPayload = { kind: 'candidate', candidate: null };
  call.listener.signal?.('a', payload);
  expect(meshes[0]?.handleSignal).toHaveBeenCalledWith('a', payload);
  meshes[0]?.opts.sendSignal('b', payload);
  expect(session.sendSignal).toHaveBeenCalledWith('b', payload);
});

test('a remote stream is attached to an element that feeds the face', () => {
  const call = makeCall();
  call.listener.welcome?.('me', ICE, true);
  call.listener.peerJoined?.(info('b'));
  const stream = { id: 's' } as unknown as MediaStream;
  meshes[0]?.opts.onRemoteStream('b', stream);
  expect(remote.attach).toHaveBeenCalledWith('b', stream);
  expect(faces.get('b')?.setVideo).toHaveBeenCalledWith({ id: 'video-el' });
});

test('remote media state toggles the face', () => {
  const call = makeCall();
  call.listener.welcome?.('me', ICE, true);
  call.listener.peerJoined?.(info('b'));
  call.listener.peerMedia?.('b', false, true);
  expect(faces.get('b')?.setCam).toHaveBeenLastCalledWith(false);
});

test('local toggles go through the controller and publish media state', async () => {
  const call = makeCall();
  expect(call.setMic(false)).toBe(false);
  expect(local.controller.setMic).toHaveBeenCalledWith(false);
  expect(session.setMedia).toHaveBeenLastCalledWith(true, false);
  await expect(call.setCam(false)).resolves.toBe(false);
  expect(local.controller.setCam).toHaveBeenCalledWith(false);
  expect(call.localState()).toEqual({ cam: false, mic: false });
  expect(session.setMedia).toHaveBeenLastCalledWith(false, false);
});

test("setCam resolves to the controller's state and publishes it", async () => {
  const call = makeCall({ cam: false, camWorks: false });
  await expect(call.setCam(true)).resolves.toBe(false);
  expect(call.localState().cam).toBe(false);
  expect(session.setMedia).toHaveBeenLastCalledWith(false, true);
});

test("media is republished when the controller's camera comes up after joining", () => {
  makeCall({ cam: false });
  expect(session.setMedia).toHaveBeenLastCalledWith(false, true);
  local.state.cam = true;
  local.notify();
  expect(session.setMedia).toHaveBeenLastCalledWith(true, true);
  const calls = (session.setMedia as ReturnType<typeof vi.fn>).mock.calls.length;
  local.notify();
  expect((session.setMedia as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
});

test('dispose closes the mesh and removes elements and faces', () => {
  const call = makeCall();
  call.listener.welcome?.('me', ICE, true);
  call.listener.peerJoined?.(info('a'));
  call.dispose();
  expect(meshes[0]?.close).toHaveBeenCalled();
  expect(remote.detachAll).toHaveBeenCalled();
  expect(faces.get('a')?.dispose).toHaveBeenCalled();
});

test('remote voices go to the audio engine and are detached when the peer goes', () => {
  const call = makeCall();
  call.listener.welcome?.('me', ICE, true);
  call.listener.peerJoined?.(info('b'));
  const stream = { id: 's' } as unknown as MediaStream;
  meshes[0]?.opts.onRemoteStream('b', stream);
  expect(audio.attach).toHaveBeenCalledWith('b', stream);
  call.listener.peerLeft?.('b');
  expect(audio.detach).toHaveBeenCalledWith('b');
});

test('a new identity detaches every voice', () => {
  const call = makeCall();
  setPeers(info('a'));
  call.listener.welcome?.('me', ICE, true);
  call.listener.welcome?.('me2', ICE, true);
  expect(audio.detach).toHaveBeenCalledWith('a');
});

test("a new mesh starts with the framer's send track", () => {
  const call = makeCall();
  call.listener.welcome?.('me', ICE, true);
  expect(meshes[0]?.setVideoTrack).toHaveBeenCalledWith({ id: 'canvas' });
  expect(meshes[0]?.opts.localStream).toBe(local.stream);
});

test('a send-track change reaches the current mesh', () => {
  const call = makeCall();
  call.listener.welcome?.('me', ICE, true);
  local.framer.sendTrack = { id: 'raw' };
  local.framer.onSendTrackChange?.();
  expect(meshes[0]?.setVideoTrack).toHaveBeenLastCalledWith({ id: 'raw' });
});

test('a boombox stream plays through the engine at its owner', () => {
  const call = makeCall();
  setPeers(info('b'));
  call.listener.welcome?.('me', ICE, true);
  const music = { id: 'music' } as unknown as MediaStream;
  meshes[0]?.opts.onRemoteBoombox('b', music);
  expect(remote.attachAudio).toHaveBeenCalledWith('boombox:b', music);
  expect(audio.attach).toHaveBeenCalledWith('boombox:b', music, 'b');
  remote.attachAudio.mockClear();
  audio.attach.mockClear();
  meshes[0]?.opts.onRemoteBoombox('stranger', music);
  expect(remote.attachAudio).not.toHaveBeenCalled();
  expect(audio.attach).not.toHaveBeenCalled();
});

test('dropping a peer detaches its boombox', () => {
  const call = makeCall();
  setPeers(info('b'));
  call.listener.welcome?.('me', ICE, true);
  call.listener.peerLeft?.('b');
  expect(remote.detach).toHaveBeenCalledWith('boombox:b');
  expect(audio.detach).toHaveBeenCalledWith('boombox:b');
});

test('a new identity detaches every boombox from the engine', () => {
  const call = makeCall();
  setPeers(info('b'));
  call.listener.welcome?.('me', ICE, true);
  call.listener.welcome?.('me2', ICE, true);
  expect(audio.detach).toHaveBeenCalledWith('boombox:b');
});

test('the boombox track reaches the mesh and survives a new identity', () => {
  const call = makeCall();
  call.listener.welcome?.('me', ICE, true);
  const track = { kind: 'audio' } as unknown as MediaStreamTrack;
  call.setBoomboxTrack(track);
  expect(meshes[0]?.setBoomboxTrack).toHaveBeenLastCalledWith(track);
  call.listener.welcome?.('me2', ICE, true);
  expect(meshes[1]?.setBoomboxTrack).toHaveBeenLastCalledWith(track);
  call.setBoomboxTrack(null);
  expect(meshes[1]?.setBoomboxTrack).toHaveBeenLastCalledWith(null);
});
