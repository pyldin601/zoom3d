import type { SignalPayload } from '@zoom3d/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { asRTCPeerConnection, FakeRTCPeerConnection } from './fake-rtc';
import { BOOMBOX_MAX_BITRATE, createMesh, WATCHDOG_CHECK_MS, WATCHDOG_MS } from './mesh';

const videoTrack = { kind: 'video' };
const audioTrack = { kind: 'audio' };
const localStream = {
  getVideoTracks: () => [videoTrack],
  getAudioTracks: () => [audioTrack],
} as unknown as MediaStream;

let sent: { to: string; payload: SignalPayload }[];
let remote: { peerId: string; stream: unknown }[];
let boomboxes: { peerId: string; stream: unknown }[];
const music = { kind: 'audio', id: 'music' };

beforeEach(() => {
  FakeRTCPeerConnection.reset();
  sent = [];
  remote = [];
  boomboxes = [];
});

const mesh = (selfId: string, stream: MediaStream | null = localStream) =>
  createMesh({
    selfId,
    iceServers: [{ urls: ['stun:test'] }],
    localStream: stream,
    sendSignal: (to, payload) => sent.push({ to, payload }),
    onRemoteStream: (peerId, s) => remote.push({ peerId, stream: s }),
    onRemoteBoombox: (peerId, s) => boomboxes.push({ peerId, stream: s }),
    createStream: (track) => ({ wraps: track }) as unknown as MediaStream,
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
    sendEncodings: [{ maxBitrate: 350_000 }],
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
    ['audio', 'sendrecv'],
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
  expect(video?.sender.parameters.encodings[0]?.maxBitrate).toBe(350_000);
  expect(audio?.sender.track).toBe(audioTrack);
  expect(sent.at(-1)).toEqual({
    to: 'b',
    payload: { kind: 'description', description: { type: 'answer', sdp: 'fake-answer' } },
  });
});

test('an answerer without local media only receives', async () => {
  await mesh('a', null).handleSignal('b', offer);
  // The boombox slot still opens: a player with no camera or mic can play music.
  expect(pc().remoteTransceivers.map((t) => t.direction)).toEqual(['recvonly', 'recvonly', 'sendrecv']);
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

test('a failed connection restarts ICE on the initiator only', async () => {
  mesh('c').connect('b');
  pc().setConnectionState('failed');
  expect(pc().restarts).toBe(1);
  await mesh('a').handleSignal('b', offer);
  pc(1).setConnectionState('failed');
  expect(pc(1).restarts).toBe(0);
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
  expect(await m.stats('b')).toEqual({ bytesReceived: 42, boomboxBytesReceived: 0 });
  expect(await m.stats('nobody')).toBeNull();
  m.close();
  await tick();
  expect(FakeRTCPeerConnection.instances.every((p) => p.closed)).toBe(true);
});

describe('recovery from lost signalling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('the initiator recreates a connection that is not connected within the watchdog window', () => {
    const m = mesh('c');
    m.connect('b');
    vi.advanceTimersByTime(WATCHDOG_MS - 1);
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    vi.advanceTimersByTime(WATCHDOG_CHECK_MS + 1);
    expect(pc(0).closed).toBe(true);
    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    // Video and the boombox slot by addTransceiver, the mic by addTrack.
    expect(pc(1).transceivers.map((t) => t.init?.direction)).toEqual(['sendrecv', 'sendrecv']);
    expect(pc(1).tracks).toHaveLength(1);
    m.close();
  });

  test('a connected pair is left alone', () => {
    const m = mesh('c');
    m.connect('b');
    pc().setConnectionState('connected');
    vi.advanceTimersByTime(WATCHDOG_MS * 3);
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    m.close();
  });

  test('the answerer never recreates on its own', async () => {
    const m = mesh('a');
    await m.handleSignal('b', offer);
    vi.advanceTimersByTime(WATCHDOG_MS * 3);
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    m.close();
  });

  test('an offer that no longer applies (new fingerprint) replaces the answerer connection', async () => {
    const m = mesh('a');
    await m.handleSignal('b', offer);
    pc(0).failNextRemote = true;
    await m.handleSignal('b', {
      kind: 'description',
      description: { type: 'offer', sdp: 'recreated-offer' },
    });
    expect(pc(0).closed).toBe(true);
    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(pc(1).calls).toEqual(['setRemote:offer', 'setLocal:answer']);
    expect(sent.at(-1)?.payload).toMatchObject({ kind: 'description', description: { type: 'answer' } });
    m.close();
  });

  test('an offer with a different DTLS fingerprint replaces the answerer connection', async () => {
    const m = mesh('a');
    const sdp = (fp: string) => `v=0\r\na=fingerprint:sha-256 ${fp}\r\n`;
    await m.handleSignal('b', { kind: 'description', description: { type: 'offer', sdp: sdp('AA:01') } });
    await m.handleSignal('b', { kind: 'description', description: { type: 'offer', sdp: sdp('AA:01') } });
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    await m.handleSignal('b', { kind: 'description', description: { type: 'offer', sdp: sdp('BB:02') } });
    expect(pc(0).closed).toBe(true);
    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(pc(1).calls).toEqual(['setRemote:offer', 'setLocal:answer']);
    m.close();
  });

  test('close stops the watchdog', () => {
    const m = mesh('c');
    m.connect('b');
    m.close();
    vi.advanceTimersByTime(WATCHDOG_MS * 3);
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
  });
});

const rawTrack = { kind: 'video', id: 'raw' } as unknown as MediaStreamTrack;

test('setVideoTrack swaps the video sender of existing connections, not audio', async () => {
  const init = mesh('b');
  init.connect('a');
  init.setVideoTrack(rawTrack);
  await tick();
  expect(pc(0).getTransceivers()[0]?.sender.track).toBe(rawTrack);

  const ans = mesh('a');
  await ans.handleSignal('b', offer);
  ans.setVideoTrack(rawTrack);
  await tick();
  const [video, audio] = pc(1).remoteTransceivers;
  expect(video?.sender.track).toBe(rawTrack);
  expect(audio?.sender.track).toBe(audioTrack);
});

test('connections made after setVideoTrack send the chosen track', async () => {
  const init = mesh('b');
  init.setVideoTrack(rawTrack);
  init.connect('a');
  expect(pc(0).transceivers[0]?.trackOrKind).toBe(rawTrack);

  const ans = mesh('a');
  ans.setVideoTrack(rawTrack);
  await ans.handleSignal('b', offer);
  expect(pc(1).remoteTransceivers[0]?.sender.track).toBe(rawTrack);
});

test('setVideoTrack does not start sending on a receive-only connection', async () => {
  const m = mesh('b', null);
  m.connect('a');
  m.setVideoTrack(rawTrack);
  await tick();
  expect(pc().getTransceivers()[0]?.sender.track).toBeNull();
});

describe('boombox transceiver', () => {
  /** An answered initiator connection to `peer`. */
  async function initiatorTo(m: ReturnType<typeof mesh>, peer: string, i: number) {
    m.connect(peer);
    await pc(i).fireNegotiationNeeded();
    await m.handleSignal(peer, { kind: 'description', description: { type: 'answer', sdp: 'remote-answer' } });
  }

  test('the initiator adds a sendrecv boombox transceiver after video and mic, capped at 128 kbps', () => {
    mesh('b').connect('a');
    expect(BOOMBOX_MAX_BITRATE).toBe(128_000);
    expect(pc().transceivers.at(-1)).toEqual({
      trackOrKind: 'audio',
      init: { direction: 'sendrecv', sendEncodings: [{ maxBitrate: 128_000 }] },
    });
    const [video, mic, boombox] = pc().getTransceivers();
    expect([video?.receiver.track.kind, mic?.sender.track, boombox?.sender.track]).toEqual(['video', audioTrack, null]);
  });

  test('a connection made while playing sends the music from the start (initiator)', () => {
    const m = mesh('b');
    m.setBoomboxTrack(music as unknown as MediaStreamTrack);
    m.connect('a');
    expect(pc().transceivers.at(-1)?.trackOrKind).toBe(music);
  });

  test('the answerer opens the boombox slot, caps it and keeps the mic off it', async () => {
    await mesh('a').handleSignal('b', offer);
    const [, mic, boombox] = pc().remoteTransceivers;
    expect(boombox?.direction).toBe('sendrecv');
    expect(boombox?.sender.track).toBeNull();
    expect(boombox?.sender.parameters.encodings[0]?.maxBitrate).toBe(128_000);
    expect(mic?.sender.track).toBe(audioTrack);
  });

  test('a connection made while playing sends the music from the start (answerer)', async () => {
    const m = mesh('a');
    m.setBoomboxTrack(music as unknown as MediaStreamTrack);
    await m.handleSignal('b', offer);
    expect(pc().remoteTransceivers[2]?.sender.track).toBe(music);
  });

  test('without local media the answerer can still play music', async () => {
    const m = mesh('a', null);
    await m.handleSignal('b', offer);
    m.setBoomboxTrack(music as unknown as MediaStreamTrack);
    await tick();
    const [video, mic, boombox] = pc().remoteTransceivers;
    expect([video?.direction, mic?.direction]).toEqual(['recvonly', 'recvonly']);
    expect([video?.sender.track, mic?.sender.track]).toEqual([null, null]);
    expect(boombox?.direction).toBe('sendrecv');
    expect(boombox?.sender.track).toBe(music);
  });

  test('setBoomboxTrack swaps the track on live connections without renegotiating', async () => {
    const m = mesh('m');
    await initiatorTo(m, 'a', 0);
    await m.handleSignal('z', offer);
    const calls = [pc(0).calls.length, pc(1).calls.length];
    const slots = () => [pc(0).getTransceivers()[2]?.sender.track, pc(1).getTransceivers()[2]?.sender.track];
    m.setBoomboxTrack(music as unknown as MediaStreamTrack);
    await tick();
    expect(slots()).toEqual([music, music]);
    m.setBoomboxTrack(null);
    await tick();
    expect(slots()).toEqual([null, null]);
    expect([pc(0).calls.length, pc(1).calls.length]).toEqual(calls);
    expect(pc(0).getTransceivers()[1]?.sender.track).toBe(audioTrack);
    expect(pc(1).getTransceivers()[0]?.sender.track).toBe(videoTrack);
  });

  test('a stale peer offering only video and mic still connects, and its mic stays the mic', async () => {
    FakeRTCPeerConnection.offerKinds = ['video', 'audio'];
    const m = mesh('a');
    await m.handleSignal('b', offer);
    expect(sent.at(-1)?.payload).toMatchObject({ description: { type: 'answer' } });
    expect(() => m.setBoomboxTrack(music as unknown as MediaStreamTrack)).not.toThrow();
    await tick();
    expect(pc().remoteTransceivers[1]?.sender.track).toBe(audioTrack);
  });

  test('a track on the boombox transceiver goes to onRemoteBoombox, once per track', () => {
    mesh('c').connect('b');
    const slot = pc().getTransceivers()[2];
    pc().fireTrack(undefined, slot, music);
    pc().fireTrack(undefined, slot, music);
    expect(boomboxes).toEqual([{ peerId: 'b', stream: { wraps: music } }]);
    expect(remote).toEqual([]);
    const stream = { id: 's' };
    pc().fireTrack(stream, pc().getTransceivers()[1], audioTrack);
    expect(remote).toEqual([{ peerId: 'b', stream }]);
  });

  test('stats count the boombox m-line separately', async () => {
    const m = mesh('c');
    m.connect('b');
    pc().inboundReports = [
      { mid: '1', bytesReceived: 100 },
      { mid: '2', bytesReceived: 40 },
    ];
    expect(await m.stats('b')).toEqual({ bytesReceived: 140, boomboxBytesReceived: 40 });
  });
});
