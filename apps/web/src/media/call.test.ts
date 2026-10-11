import type { LiveKitAccess, PeerInfo } from '@zoom3d/shared';
import { beforeEach, expect, test, vi } from 'vitest';
import type { AudioEngine } from '../audio/engine';
import type { RemotePeer, Session } from '../net/session';
import { createCall } from './call';
import type { FaceSource } from './faces';
import type { LocalMediaController } from './local-media';
import type { RemoteMedia } from './remote-media';
import type { TransportOptions } from './transport';

const LK: LiveKitAccess = { url: 'ws://lk', token: 'tok' };
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

let transports: {
  opts: TransportOptions;
  close: ReturnType<typeof vi.fn>;
  setVideoTracks: ReturnType<typeof vi.fn>;
  setWanted: ReturnType<typeof vi.fn>;
  publishes: ReturnType<typeof vi.fn>;
  setAudioTrack: ReturnType<typeof vi.fn>;
  setBoomboxTrack: ReturnType<typeof vi.fn>;
  setAccess: ReturnType<typeof vi.fn>;
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

const CANVASES = { 256: { id: 'canvas' }, 128: { id: 'canvas-128' }, 64: { id: 'canvas-64' } };
function fakeFramer() {
  const framer = {
    track: CANVASES[256],
    tracks: CANVASES,
    send: CANVASES as Record<number, unknown>,
    sendTracks: () => framer.send,
    onSendTrackChange: null as (() => void) | null,
  };
  return framer;
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
  let micTrack: unknown = { id: 'mic1' };
  return {
    state,
    setMicTrack(t: unknown) {
      micTrack = t;
      notify();
    },
    framer: fakeFramer(),
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
      micTrack: () => micTrack,
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
        setPaused: vi.fn(),
        dispose: vi.fn(),
      };
      faces.set(name, face as never);
      return face;
    },
    createTransport: (opts) => {
      const transport = {
        opts,
        close: vi.fn(),
        stats: vi.fn(async () => ({ bytesReceived: 5, boomboxBytesReceived: 2 })),
        setVideoTracks: vi.fn(),
        setWanted: vi.fn(),
        publishes: vi.fn((id: string) => id === 'a'),
        setAudioTrack: vi.fn(),
        setBoomboxTrack: vi.fn(),
        setAccess: vi.fn(),
      };
      transports.push(transport);
      return transport;
    },
  });
  call.attach(session);
  return call;
}

beforeEach(() => {
  transports = [];
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
    setMedia: vi.fn(),
  } as unknown as Session;
});

test('attaching publishes the local media state', () => {
  makeCall({ cam: false, mic: true });
  expect(session.setMedia).toHaveBeenCalledWith(false, true);
});

test('a fresh welcome creates a transport and a face for every peer', () => {
  const call = makeCall();
  setPeers(info('a'), info('b', false));
  call.listener.welcome?.('me', LK, true);
  expect(transports).toHaveLength(1);
  expect(transports[0]?.opts).toMatchObject({ url: 'ws://lk', token: 'tok' });
  expect([...faces.keys()]).toEqual(['a', 'b']);
  expect(faces.get('b')?.setCam).toHaveBeenCalledWith(false);
  expect(call.faceOf('a')).toBe(faces.get('a')?.texels);
});

test("faces get the peer's avatar picture", () => {
  const call = makeCall();
  const pic = 'data:image/jpeg;base64,/9j/';
  setPeers({ ...info('a'), avatar: pic });
  call.listener.welcome?.('me', LK, true);
  call.listener.peerJoined?.(info('b'));
  expect(faceAvatars.get('a')).toBe(pic);
  expect(faceAvatars.get('b')).toBeNull();
});

test('a resume keeps the transport, adds newcomers and drops peers that are gone', () => {
  const call = makeCall();
  setPeers(info('a'), info('b'));
  call.listener.welcome?.('me', LK, true);
  setPeers(info('b'), info('c'));
  call.listener.welcome?.('me', LK, false);
  expect(transports).toHaveLength(1);
  expect(call.faceOf('a')).toBeNull();
  expect(call.faceOf('c')).toBe(faces.get('c')?.texels);
  expect(faces.get('a')?.dispose).toHaveBeenCalled();
});

test('a new identity replaces the transport entirely', () => {
  const call = makeCall();
  setPeers(info('a'));
  call.listener.welcome?.('me', LK, true);
  call.listener.welcome?.('me2', { url: 'ws://lk', token: 'tok2' }, true);
  expect(transports[0]?.close).toHaveBeenCalled();
  expect(remote.detachAll).toHaveBeenCalled();
  expect(transports[1]?.opts.token).toBe('tok2');
});

test('peers joining get a face; leaving cleans up', () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
  call.listener.peerJoined?.(info('a'));
  expect(call.faceOf('a')).toBe(faces.get('a')?.texels);
  call.listener.peerLeft?.('a');
  expect(remote.detach).toHaveBeenCalledWith('a');
  expect(faces.get('a')?.dispose).toHaveBeenCalled();
  expect(call.faceOf('a')).toBeNull();
});

test('a resume keeps the transport even though its welcome carries a fresh token', () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
  call.listener.welcome?.('me', { url: 'ws://lk', token: 'fresh' }, false);
  expect(transports).toHaveLength(1);
  expect(transports[0]?.close).not.toHaveBeenCalled();
  // Tokens expire: the transport keeps the latest for its next reconnect.
  expect(transports[0]?.setAccess).toHaveBeenCalledWith({ url: 'ws://lk', token: 'fresh' });
});

test('media that arrives before the game announces the peer is applied once it does', () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
  const stream = { id: 'early' } as unknown as MediaStream;
  const music = { id: 'early-music' } as unknown as MediaStream;
  transports[0]?.opts.onRemoteStream('c', stream);
  transports[0]?.opts.onRemoteBoombox('c', music);
  expect(remote.attach).not.toHaveBeenCalled();
  call.listener.peerJoined?.(info('c'));
  expect(remote.attach).toHaveBeenCalledWith('c', stream);
  expect(faces.get('c')?.setVideo).toHaveBeenCalledWith({ id: 'video-el' });
  expect(audio.attach).toHaveBeenCalledWith('c', stream);
  expect(remote.attachAudio).toHaveBeenCalledWith('boombox:c', music);
});

test('a remote stream is attached to an element that feeds the face', () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
  call.listener.peerJoined?.(info('b'));
  const stream = { id: 's' } as unknown as MediaStream;
  transports[0]?.opts.onRemoteStream('b', stream);
  expect(remote.attach).toHaveBeenCalledWith('b', stream);
  expect(faces.get('b')?.setVideo).toHaveBeenCalledWith({ id: 'video-el' });
});

test('remote media state toggles the face', () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
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

test('dispose closes the transport and removes elements and faces', () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
  call.listener.peerJoined?.(info('a'));
  call.dispose();
  expect(transports[0]?.close).toHaveBeenCalled();
  expect(remote.detachAll).toHaveBeenCalled();
  expect(faces.get('a')?.dispose).toHaveBeenCalled();
});

test('remote voices go to the audio engine and are detached when the peer goes', () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
  call.listener.peerJoined?.(info('b'));
  const stream = { id: 's' } as unknown as MediaStream;
  transports[0]?.opts.onRemoteStream('b', stream);
  expect(audio.attach).toHaveBeenCalledWith('b', stream);
  call.listener.peerLeft?.('b');
  expect(audio.detach).toHaveBeenCalledWith('b');
});

test('a new identity detaches every voice', () => {
  const call = makeCall();
  setPeers(info('a'));
  call.listener.welcome?.('me', LK, true);
  call.listener.welcome?.('me2', LK, true);
  expect(audio.detach).toHaveBeenCalledWith('a');
});

test("a new transport starts with the framer's send tracks", () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
  expect(transports[0]?.setVideoTracks).toHaveBeenCalledWith(CANVASES);
  expect(transports[0]?.opts.localStream).toBe(local.stream);
});

test('wants reach the transport; a face pauses while its video is off', () => {
  const call = makeCall();
  setPeers(info('a'));
  call.listener.welcome?.('me', LK, true);
  call.setWanted('a', { video: 'off', audio: true });
  expect(transports[0]?.setWanted).toHaveBeenLastCalledWith('a', { video: 'off', audio: true });
  expect(faces.get('a')?.setPaused).toHaveBeenLastCalledWith(true);
  call.setWanted('a', { video: 64, audio: true });
  expect(transports[0]?.setWanted).toHaveBeenLastCalledWith('a', { video: 64, audio: true });
  expect(faces.get('a')?.setPaused).toHaveBeenLastCalledWith(false);
});

test('wants made before a face or a transport exists are applied when they do', () => {
  const call = makeCall();
  call.setWanted('a', { video: 'off', audio: false });
  setPeers(info('a'));
  call.listener.welcome?.('me', LK, true);
  expect(transports[0]?.setWanted).toHaveBeenCalledWith('a', { video: 'off', audio: false });
  expect(faces.get('a')?.setPaused).toHaveBeenCalledWith(true);
  call.listener.welcome?.('me2', LK, true);
  expect(transports[1]?.setWanted).toHaveBeenCalledWith('a', { video: 'off', audio: false });
});

test('publishes asks the transport (false without one)', () => {
  const call = makeCall();
  expect(call.publishes('a')).toBe(false);
  call.listener.welcome?.('me', LK, true);
  expect(call.publishes('a')).toBe(true);
  expect(call.publishes('bot')).toBe(false);
});

test('a peer that leaves is forgotten', () => {
  const call = makeCall();
  setPeers(info('a'));
  call.listener.welcome?.('me', LK, true);
  call.setWanted('a', { video: 256, audio: true });
  call.listener.peerLeft?.('a');
  call.listener.welcome?.('me2', LK, true);
  expect(transports[1]?.setWanted).not.toHaveBeenCalled();
});

test('a replaced mic reaches the current transport', () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
  local.setMicTrack({ id: 'mic2' });
  expect(transports[0]?.setAudioTrack).toHaveBeenCalledWith({ id: 'mic2' });
  transports[0]?.setAudioTrack.mockClear();
  local.notify();
  expect(transports[0]?.setAudioTrack).not.toHaveBeenCalled();
});

test('a send-track change reaches the current transport', () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
  const raw = { id: 'raw' };
  local.framer.send = { 256: raw, 128: raw, 64: raw };
  local.framer.onSendTrackChange?.();
  expect(transports[0]?.setVideoTracks).toHaveBeenLastCalledWith({ 256: raw, 128: raw, 64: raw });
});

test('a boombox stream plays through the engine at its owner', () => {
  const call = makeCall();
  setPeers(info('b'));
  call.listener.welcome?.('me', LK, true);
  const music = { id: 'music' } as unknown as MediaStream;
  transports[0]?.opts.onRemoteBoombox('b', music);
  expect(remote.attachAudio).toHaveBeenCalledWith('boombox:b', music);
  expect(audio.attach).toHaveBeenCalledWith('boombox:b', music, 'b');
  remote.attachAudio.mockClear();
  audio.attach.mockClear();
  transports[0]?.opts.onRemoteBoombox('stranger', music);
  expect(remote.attachAudio).not.toHaveBeenCalled();
  expect(audio.attach).not.toHaveBeenCalled();
});

test('dropping a peer detaches its boombox', () => {
  const call = makeCall();
  setPeers(info('b'));
  call.listener.welcome?.('me', LK, true);
  call.listener.peerLeft?.('b');
  expect(remote.detach).toHaveBeenCalledWith('boombox:b');
  expect(audio.detach).toHaveBeenCalledWith('boombox:b');
});

test('a new identity detaches every boombox from the engine', () => {
  const call = makeCall();
  setPeers(info('b'));
  call.listener.welcome?.('me', LK, true);
  call.listener.welcome?.('me2', LK, true);
  expect(audio.detach).toHaveBeenCalledWith('boombox:b');
});

test('the boombox track reaches the transport and survives a new identity', () => {
  const call = makeCall();
  call.listener.welcome?.('me', LK, true);
  const track = { kind: 'audio' } as unknown as MediaStreamTrack;
  call.setBoomboxTrack(track);
  expect(transports[0]?.setBoomboxTrack).toHaveBeenLastCalledWith(track);
  call.listener.welcome?.('me2', LK, true);
  expect(transports[1]?.setBoomboxTrack).toHaveBeenLastCalledWith(track);
  call.setBoomboxTrack(null);
  expect(transports[1]?.setBoomboxTrack).toHaveBeenLastCalledWith(null);
});
