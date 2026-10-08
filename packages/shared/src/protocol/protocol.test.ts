import { describe, expect, test } from 'vitest';
import {
  AVATAR_MAX_CHARS,
  AVATAR_SIZE,
  isValidAvatar,
  isValidRoomId,
  MAX_MESSAGE_BYTES,
  MAX_SERVER_MESSAGE_BYTES,
  newRoomId,
  type PeerInfo,
  parseClientMessage,
  parseServerMessage,
  type ServerMessage,
  sanitizeName,
} from './protocol';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const json = (v: unknown) => JSON.stringify(v);
const AVATAR = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

describe('avatars', () => {
  test('constants', () => {
    expect(AVATAR_SIZE).toBe(128);
    expect(AVATAR_MAX_CHARS).toBe(12_000);
    expect(MAX_SERVER_MESSAGE_BYTES).toBe(131_072);
  });

  test('accepts a JPEG data URL up to the cap', () => {
    expect(isValidAvatar(AVATAR)).toBe(true);
    const prefix = 'data:image/jpeg;base64,';
    expect(isValidAvatar(prefix + 'A'.repeat(AVATAR_MAX_CHARS - prefix.length))).toBe(true);
    expect(isValidAvatar(prefix + 'A'.repeat(AVATAR_MAX_CHARS - prefix.length + 1))).toBe(false);
  });

  test.each([
    ['png', 'data:image/png;base64,iVBORw0KGgo='],
    ['svg', 'data:image/svg+xml;base64,PHN2Zz4='],
    ['script url', 'javascript:alert(1)'],
    ['http url', 'https://example.com/a.jpg'],
    ['non-base64', 'data:image/jpeg;base64,<b>'],
    ['empty payload', 'data:image/jpeg;base64,'],
    ['padding in the middle', 'data:image/jpeg;base64,AA=A'],
    ['number', 42],
    ['null', null],
  ])('rejects %s', (_name, v) => {
    expect(isValidAvatar(v)).toBe(false);
  });
});

describe('room ids', () => {
  test('newRoomId encodes 16 bytes as 22 base64url chars', () => {
    expect(newRoomId(new Uint8Array(16))).toBe(ROOM);
    expect(newRoomId(new Uint8Array(16).fill(255))).toBe('_____________________w');
    expect(isValidRoomId(newRoomId(Uint8Array.from({ length: 16 }, (_, i) => i * 17)))).toBe(true);
  });

  test('isValidRoomId rejects wrong length, alphabet and type', () => {
    expect(isValidRoomId(ROOM)).toBe(true);
    for (const bad of [
      ROOM.slice(1),
      `${ROOM}A`,
      `${ROOM.slice(1)}+`,
      `${ROOM.slice(1)}/`,
      `${ROOM.slice(1)}=`,
      42,
      null,
    ]) {
      expect(isValidRoomId(bad)).toBe(false);
    }
  });
});

describe('sanitizeName', () => {
  test('trims and collapses whitespace, strips control characters', () => {
    expect(sanitizeName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(sanitizeName('a\u0000b')).toBe('ab');
  });

  test('rejects empty, too long and non-strings', () => {
    for (const bad of ['', '   ', 'x'.repeat(25), 42, undefined]) expect(sanitizeName(bad)).toBeNull();
  });

  test('counts code points, not UTF-16 units', () => {
    expect(sanitizeName('😀'.repeat(24))).toBe('😀'.repeat(24));
    expect(sanitizeName('😀'.repeat(25))).toBeNull();
  });

  test('leaves markup alone (rendering escapes it)', () => {
    expect(sanitizeName('<b>x</b>')).toBe('<b>x</b>');
  });
});

describe('parseClientMessage', () => {
  test('accepts join with and without resumeToken, dropping extra fields', () => {
    expect(parseClientMessage(json({ type: 'join', roomId: ROOM, name: ' Ada ', extra: 1 }))).toEqual({
      type: 'join',
      roomId: ROOM,
      name: 'Ada',
    });
    expect(parseClientMessage(json({ type: 'join', roomId: ROOM, name: 'Ada', resumeToken: 'tok' }))).toEqual(
      {
        type: 'join',
        roomId: ROOM,
        name: 'Ada',
        resumeToken: 'tok',
      },
    );
  });

  test('keeps a valid join avatar and drops an invalid one', () => {
    expect(parseClientMessage(json({ type: 'join', roomId: ROOM, name: 'Ada', avatar: AVATAR }))).toEqual({
      type: 'join',
      roomId: ROOM,
      name: 'Ada',
      avatar: AVATAR,
    });
    expect(
      parseClientMessage(json({ type: 'join', roomId: ROOM, name: 'Ada', resumeToken: 't', avatar: 'nope' })),
    ).toEqual({ type: 'join', roomId: ROOM, name: 'Ada', resumeToken: 't' });
  });

  test('a join with a full-size avatar fits the client message cap', () => {
    const avatar = `data:image/jpeg;base64,${'A'.repeat(AVATAR_MAX_CHARS - 23)}`;
    const raw = json({
      type: 'join',
      roomId: ROOM,
      name: 'x'.repeat(24),
      resumeToken: 't'.repeat(64),
      avatar,
    });
    expect(parseClientMessage(raw)).not.toBeNull();
  });

  test('accepts state', () => {
    expect(parseClientMessage(json({ type: 'state', x: 1.5, y: 2, angle: 0.1, seq: 3, z: 9 }))).toEqual({
      type: 'state',
      x: 1.5,
      y: 2,
      angle: 0.1,
      seq: 3,
    });
  });

  test.each([
    ['non-JSON', 'not json'],
    ['array', '[]'],
    ['null', 'null'],
    ['unknown type', json({ type: 'nope' })],
    ['string number', json({ type: 'state', x: '1', y: 2, angle: 0, seq: 0 })],
    ['infinite number', '{"type":"state","x":1e999,"y":2,"angle":0,"seq":0}'],
    ['NaN string', json({ type: 'state', x: 'NaN', y: 2, angle: 0, seq: 0 })],
    ['negative seq', json({ type: 'state', x: 1, y: 2, angle: 0, seq: -1 })],
    ['fractional seq', json({ type: 'state', x: 1, y: 2, angle: 0, seq: 1.5 })],
    ['bad room', json({ type: 'join', roomId: 'short', name: 'Ada' })],
    ['bad name', json({ type: 'join', roomId: ROOM, name: '   ' })],
    ['non-string token', json({ type: 'join', roomId: ROOM, name: 'Ada', resumeToken: 5 })],
    ['oversized', json({ type: 'join', roomId: ROOM, name: 'Ada', pad: 'x'.repeat(MAX_MESSAGE_BYTES) })],
  ])('rejects %s', (_name, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});

describe('parseServerMessage', () => {
  const peer: PeerInfo = {
    id: 'p1',
    name: 'Ada',
    color: '#e6194b',
    x: 1,
    y: 2,
    angle: 0,
    cam: true,
    mic: false,
    avatar: null,
  };
  const samples: ServerMessage[] = [
    {
      type: 'welcome',
      selfId: 'p2',
      resumeToken: 't',
      color: '#3cb44b',
      spawn: { x: 1, y: 2, angle: 0 },
      peers: [peer],
      iceServers: [{ urls: ['stun:x'] }, { urls: ['turn:y'], username: 'u', credential: 'c' }],
    },
    { type: 'peer_media', id: 'p1', cam: false, mic: true },
    {
      type: 'signal',
      from: 'p1',
      payload: { kind: 'description', description: { type: 'answer', sdp: 'v=0' } },
    },
    { type: 'peer_joined', peer },
    { type: 'peer_joined', peer: { ...peer, avatar: AVATAR } },
    { type: 'peer_left', id: 'p1' },
    { type: 'peer_state', id: 'p1', x: 1, y: 2, angle: 3, seq: 4 },
    { type: 'correction', x: 1, y: 2, angle: 3, seq: 4 },
    { type: 'error', code: 'room_full', message: 'full' },
  ];

  test.each(samples)('round-trips $type', (msg) => {
    expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
  });

  test('rejects a welcome whose peer lacks a colour', () => {
    const bad = { ...samples[0], peers: [{ ...peer, color: undefined }] };
    expect(parseServerMessage(JSON.stringify(bad))).toBeNull();
  });

  test('rejects a peer with a non-string avatar', () => {
    expect(parseServerMessage(json({ type: 'peer_joined', peer: { ...peer, avatar: 5 } }))).toBeNull();
  });

  test('a peer without an avatar field (older server) parses with avatar null', () => {
    const { avatar: _omit, ...older } = peer;
    expect(parseServerMessage(json({ type: 'peer_joined', peer: older }))).toEqual({
      type: 'peer_joined',
      peer: { ...peer, avatar: null },
    });
  });

  test('a peer with an invalid avatar parses with avatar null', () => {
    expect(
      parseServerMessage(json({ type: 'peer_joined', peer: { ...peer, avatar: 'javascript:x' } })),
    ).toEqual({
      type: 'peer_joined',
      peer: { ...peer, avatar: null },
    });
  });

  test('server messages may exceed the client cap up to their own cap', () => {
    const avatar = `data:image/jpeg;base64,${'A'.repeat(AVATAR_MAX_CHARS - 23)}`;
    const welcome = {
      ...samples[0],
      peers: Array.from({ length: 7 }, (_, i) => ({ ...peer, id: `p${i}`, avatar })),
    };
    expect(json(welcome).length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(parseServerMessage(json(welcome))).not.toBeNull();
    const huge = { ...welcome, pad: 'x'.repeat(MAX_SERVER_MESSAGE_BYTES) };
    expect(parseServerMessage(json(huge))).toBeNull();
  });

  test('rejects unknown error codes', () => {
    expect(parseServerMessage(json({ type: 'error', code: 'boom', message: '' }))).toBeNull();
  });
});

describe('media and signal messages', () => {
  const offer = { kind: 'description', description: { type: 'offer', sdp: 'v=0\r\n' } };
  const cand = {
    candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: null,
  };
  const candidate = { kind: 'candidate', candidate: cand };

  test('client media is accepted with booleans only', () => {
    expect(parseClientMessage(json({ type: 'media', cam: true, mic: false, x: 1 }))).toEqual({
      type: 'media',
      cam: true,
      mic: false,
    });
    expect(parseClientMessage(json({ type: 'media', cam: 'yes', mic: false }))).toBeNull();
  });

  test('client signal carries descriptions and candidates, extra fields stripped', () => {
    expect(parseClientMessage(json({ type: 'signal', to: 'p2', payload: { ...offer, junk: 1 } }))).toEqual({
      type: 'signal',
      to: 'p2',
      payload: offer,
    });
    expect(parseClientMessage(json({ type: 'signal', to: 'p2', payload: candidate }))).toEqual({
      type: 'signal',
      to: 'p2',
      payload: candidate,
    });
    const end = { kind: 'candidate', candidate: null };
    expect(parseClientMessage(json({ type: 'signal', to: 'p2', payload: end }))).toEqual({
      type: 'signal',
      to: 'p2',
      payload: end,
    });
  });

  test.each([
    ['bogus description type', { kind: 'description', description: { type: 'bogus', sdp: '' } }],
    ['oversized sdp', { kind: 'description', description: { type: 'offer', sdp: 'x'.repeat(12001) } }],
    ['oversized candidate', { kind: 'candidate', candidate: { ...cand, candidate: 'x'.repeat(1025) } }],
    ['fractional mline', { kind: 'candidate', candidate: { ...cand, sdpMLineIndex: 1.5 } }],
    ['unknown kind', { kind: 'hello' }],
  ])('rejects signal with %s', (_name, payload) => {
    expect(parseClientMessage(json({ type: 'signal', to: 'p2', payload }))).toBeNull();
  });

  test('rejects signal with a non-string target', () => {
    expect(parseClientMessage(json({ type: 'signal', to: 5, payload: offer }))).toBeNull();
  });

  test('rejects a welcome with string urls or a peer without cam', () => {
    const base = {
      type: 'welcome',
      selfId: 'p2',
      resumeToken: 't',
      color: '#3cb44b',
      spawn: { x: 1, y: 2, angle: 0 },
      peers: [] as unknown[],
      iceServers: [{ urls: ['stun:x'] }],
    };
    expect(parseServerMessage(json(base))).not.toBeNull();
    expect(parseServerMessage(json({ ...base, iceServers: [{ urls: 'stun:x' }] }))).toBeNull();
    const noCam = { id: 'a', name: 'A', color: '#fff', x: 1, y: 1, angle: 0, mic: true };
    expect(parseServerMessage(json({ ...base, peers: [noCam] }))).toBeNull();
  });
});
