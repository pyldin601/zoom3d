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

test('only the peer with the greater id initiates; the other waits for its offer', () => {
  mesh('a').connect('b');
  expect(FakeRTCPeerConnection.instances).toHaveLength(0);
});

test('the initiator adds a bitrate-capped video transceiver and the audio track, then offers', async () => {
  const m = mesh('b');
  m.connect('a');
  m.connect('a');
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
    { to: 'a', payload: { kind: 'description', description: { type: 'offer', sdp: 'fake-offer' } } },
  ]);
});

test('without local media the initiator still receives video and audio', () => {
  mesh('b', null).connect('a');
  expect(pc().transceivers.map((t) => [t.trackOrKind, t.init?.direction])).toEqual([
    ['video', 'recvonly'],
    ['audio', 'recvonly'],
  ]);
});

test('the answerer attaches its local tracks to the offered transceivers before answering', async () => {
  const m = mesh('a');
  await m.handleSignal('b', offer);
  expect(pc().calls).toEqual(['setRemote:offer', 'setLocal:answer']);
  expect(pc().transceivers).toEqual([]);
  const [video, audio] = pc().remoteTransceivers;
  expect(video?.direction).toBe('sendrecv');
  expect(video?.sender.track).toBe(videoTrack);
  expect(video?.sender.streams).toEqual([localStream]);
  expect(video?.sender.parameters.encodings[0]?.maxBitrate).toBe(150_000);
  expect(audio?.sender.track).toBe(audioTrack);
  expect(sent.at(-1)).toEqual({
    to: 'b',
    payload: { kind: 'description', description: { type: 'answer', sdp: 'fake-answer' } },
  });
});

test('an answerer without local media only receives', async () => {
  await mesh('a', null).handleSignal('b', offer);
  expect(pc().remoteTransceivers.map((t) => t.direction)).toEqual(['recvonly', 'recvonly']);
});

test('glare on renegotiation: the impolite side ignores the colliding offer and swallows its candidates', async () => {
  const m = mesh('b');
  m.connect('a');
  const making = pc().fireNegotiationNeeded();
  await m.handleSignal('a', offer);
  await making;
  expect(pc().calls).not.toContain('setRemote:offer');
  await expect(m.handleSignal('a', candidate)).resolves.toBeUndefined();
});

test('glare on renegotiation: the polite side accepts the colliding offer and answers', async () => {
  const m = mesh('a');
  await m.handleSignal('b', offer);
  const making = pc().fireNegotiationNeeded();
  await m.handleSignal('b', { kind: 'description', description: { type: 'offer', sdp: 'second-offer' } });
  await making;
  expect(pc().calls.filter((c) => c === 'setRemote:offer')).toHaveLength(2);
  expect(sent.at(-1)?.payload).toEqual({
    kind: 'description',
    description: { type: 'answer', sdp: 'fake-answer' },
  });
});

test('ICE candidates are sent, including end-of-candidates', () => {
  mesh('c').connect('b');
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
  mesh('c').connect('b');
  const stream = { id: 's' };
  pc().fireTrack(stream);
  expect(remote).toEqual([{ peerId: 'b', stream }]);
});

test('a failed connection restarts ICE', () => {
  mesh('c').connect('b');
  pc().setConnectionState('failed');
  expect(pc().restarts).toBe(1);
});

test('disconnect closes; stray candidates create nothing, a new offer reconnects', async () => {
  const m = mesh('c');
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
  const m = mesh('z');
  m.connect('b');
  m.connect('c');
  pc(0).bytesReceived = 42;
  expect(await m.stats('b')).toEqual({ bytesReceived: 42 });
  expect(await m.stats('nobody')).toBeNull();
  m.close();
  await tick();
  expect(FakeRTCPeerConnection.instances.every((p) => p.closed)).toBe(true);
});
