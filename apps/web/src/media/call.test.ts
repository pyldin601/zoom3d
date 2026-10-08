import type { IceServer, PeerInfo, SignalPayload } from '@zoom3d/shared';
import { beforeEach, expect, test, vi } from 'vitest';
import type { RemotePeer, Session } from '../net/session';
import { createCall } from './call';
import type { LocalMedia } from './capture';
import type { FaceSource } from './faces';
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
});

let meshes: {
  opts: MeshOptions;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  handleSignal: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}[];
let faces: Map<string, FaceSource & { [k: string]: unknown }>;
let session: Session;
let remote: {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  detachAll: ReturnType<typeof vi.fn>;
};
let videoTrack: { enabled: boolean };
let audioTrack: { enabled: boolean };

function setPeers(...peers: PeerInfo[]) {
  session.peers.clear();
  for (const p of peers) session.peers.set(p.id, { info: p } as RemotePeer);
}

function makeCall(local?: Partial<LocalMedia>) {
  const call = createCall({
    local: {
      stream: {
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [audioTrack],
      } as unknown as MediaStream,
      cam: true,
      mic: true,
      problem: null,
      ...local,
    },
    remote: remote as unknown as RemoteMedia,
    document: {} as Document,
    createFace: ({ name }) => {
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
        stats: vi.fn(async () => ({ bytesReceived: 5 })),
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
  videoTrack = { enabled: true };
  audioTrack = { enabled: true };
  remote = { attach: vi.fn(() => ({ id: 'video-el' })), detach: vi.fn(), detachAll: vi.fn() };
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

test('local toggles flip tracks and publish media state', () => {
  const call = makeCall();
  call.setMic(false);
  expect(audioTrack.enabled).toBe(false);
  expect(session.setMedia).toHaveBeenLastCalledWith(true, false);
  call.setCam(false);
  expect(videoTrack.enabled).toBe(false);
  expect(call.localState()).toEqual({ cam: false, mic: false });
});

test('toggles cannot turn on media that was never captured', () => {
  const call = makeCall({ cam: false });
  call.setCam(true);
  expect(call.localState().cam).toBe(false);
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
