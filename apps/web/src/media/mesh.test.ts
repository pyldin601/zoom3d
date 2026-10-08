import type { SignalPayload } from '@zoom3d/shared';
import { beforeEach, expect, test } from 'vitest';
import { asRTCPeerConnection, FakeRTCPeerConnection } from './fake-rtc';
import { createMesh } from './mesh';

const videoTrack = { kind: 'video' };
const audioTrack = { kind: 'audio' };
const localStream = {
  getVideoTracks: () => [videoTrack],
  getAudioTracks: () => [audioTrack],
} as unknown as MediaStream;

let sent: { to: string; payload: SignalPayload }[];
let remote: { peerId: string; stream: unknown }[];

beforeEach(() => {
  FakeRTCPeerConnection.reset();
  sent = [];
  remote = [];
});

const mesh = (selfId: string, stream: MediaStream | null = localStream) =>
  createMesh({
    selfId,
    iceServers: [{ urls: ['stun:test'] }],
    localStream: stream,
    sendSignal: (to, payload) => sent.push({ to, payload }),
    onRemoteStream: (peerId, s) => remote.push({ peerId, stream: s }),
    RTCPeerConnectionImpl: asRTCPeerConnection,
  });
const pc = (i = 0) => FakeRTCPeerConnection.instances[i] as FakeRTCPeerConnection;
const offer: SignalPayload = { kind: 'description', description: { type: 'offer', sdp: 'remote-offer' } };
const candidate: SignalPayload = {
  kind: 'candidate',
  candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null },
};
const tick = () => new Promise((r) => setTimeout(r, 0));

test('connect adds a bitrate-capped video transceiver and the audio track, then offers on negotiationneeded', async () => {
  const m = mesh('a');
  m.connect('b');
  m.connect('b');
  expect(FakeRTCPeerConnection.instances).toHaveLength(1);
  expect(pc().config.iceServers).toEqual([{ urls: ['stun:test'] }]);
  expect(pc().transceivers[0]?.trackOrKind).toBe(videoTrack);
  expect(pc().transceivers[0]?.init).toMatchObject({
    direction: 'sendrecv',
    sendEncodings: [{ maxBitrate: 150_000 }],
  });
  expect(pc().tracks).toEqual([audioTrack]);
  await pc().fireNegotiationNeeded();
  expect(sent).toEqual([
    { to: 'b', payload: { kind: 'description', description: { type: 'offer', sdp: 'fake-offer' } } },
  ]);
});

test('without local media it still receives video and audio', () => {
  mesh('a', null).connect('b');
  expect(pc().transceivers.map((t) => [t.trackOrKind, t.init?.direction])).toEqual([
    ['video', 'recvonly'],
    ['audio', 'recvonly'],
  ]);
});

test('an offer while stable is answered', async () => {
  const m = mesh('a');
  await m.handleSignal('b', offer);
  expect(pc().calls).toEqual(['setRemote:offer', 'setLocal:answer']);
  expect(sent.at(-1)).toEqual({
    to: 'b',
    payload: { kind: 'description', description: { type: 'answer', sdp: 'fake-answer' } },
  });
});

test('glare: the impolite side ignores the colliding offer and swallows its candidates', async () => {
  const m = mesh('b');
  m.connect('a');
  const making = pc().fireNegotiationNeeded();
  await m.handleSignal('a', offer);
  await making;
  expect(pc().calls).not.toContain('setRemote:offer');
  await expect(m.handleSignal('a', candidate)).resolves.toBeUndefined();
});

test('glare: the polite side accepts the colliding offer and answers', async () => {
  const m = mesh('a');
  m.connect('b');
  const making = pc().fireNegotiationNeeded();
  await m.handleSignal('b', offer);
  await making;
  expect(pc().calls).toContain('setRemote:offer');
  expect(sent.at(-1)?.payload).toEqual({
    kind: 'description',
    description: { type: 'answer', sdp: 'fake-answer' },
  });
});

test('ICE candidates are sent, including end-of-candidates', () => {
  mesh('a').connect('b');
  pc().onicecandidate?.({
    candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u', extra: 1 },
  });
  pc().onicecandidate?.({ candidate: null });
  expect(sent.map((s) => s.payload)).toEqual([
    {
      kind: 'candidate',
      candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' },
    },
    { kind: 'candidate', candidate: null },
  ]);
});

test('remote tracks are reported with their stream', () => {
  mesh('a').connect('b');
  const stream = { id: 's' };
  pc().fireTrack(stream);
  expect(remote).toEqual([{ peerId: 'b', stream }]);
});

test('a failed connection restarts ICE', () => {
  mesh('a').connect('b');
  pc().setConnectionState('failed');
  expect(pc().restarts).toBe(1);
});

test('disconnect closes; stray candidates create nothing, a new offer reconnects', async () => {
  const m = mesh('a');
  m.connect('b');
  m.disconnect('b');
  expect(pc(0).closed).toBe(true);
  await m.handleSignal('b', candidate);
  expect(FakeRTCPeerConnection.instances).toHaveLength(1);
  await m.handleSignal('b', offer);
  expect(FakeRTCPeerConnection.instances).toHaveLength(2);
});

test('signals from unknown peers that are not offers are ignored', async () => {
  await expect(mesh('a').handleSignal('z', candidate)).resolves.toBeUndefined();
  expect(FakeRTCPeerConnection.instances).toHaveLength(0);
});

test('stats sum inbound bytes; close closes everything', async () => {
  const m = mesh('a');
  m.connect('b');
  m.connect('c');
  pc(0).bytesReceived = 42;
  expect(await m.stats('b')).toEqual({ bytesReceived: 42 });
  expect(await m.stats('nobody')).toBeNull();
  m.close();
  await tick();
  expect(FakeRTCPeerConnection.instances.every((p) => p.closed)).toBe(true);
});
