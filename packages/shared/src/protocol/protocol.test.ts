import { describe, expect, test } from 'vitest';
import {
  AVATAR_MAX_CHARS,
  AVATAR_SIZE,
  avatarPath,
  CHEERS_MS,
  DRINK_GAP_MS,
  FANOUT_TICK_MS,
  FAR_INTERVAL_MS,
  HELD_ITEMS,
  isAvatarId,
  isHeldItem,
  isValidAvatar,
  isValidRoomId,
  MAX_BOTS,
  MAX_MESSAGE_BYTES,
  MAX_PEERS,
  MAX_SERVER_MESSAGE_BYTES,
  NEAR_TILES,
  newRoomId,
  type PeerInfo,
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  peerEntry,
  type ServerMessage,
  SIP_MS,
  sanitizeName,
} from './protocol';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const json = (v: unknown) => JSON.stringify(v);
const AVATAR = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const AVATAR_ID = 'abcdefghijklmnopqrstu-';

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
    for (const bad of ['', '   ', 'x'.repeat(25), 42, undefined]) {
      expect(sanitizeName(bad)).toBeNull();
    }
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
    expect(parseClientMessage(json({ type: 'join', roomId: ROOM, name: 'Ada', resumeToken: 'tok' }))).toEqual({
      type: 'join',
      roomId: ROOM,
      name: 'Ada',
      resumeToken: 'tok',
    });
  });

  test('a join may ask for 1 to MAX_BOTS bots; anything else is dropped (bots spec)', () => {
    expect(MAX_BOTS).toBe(100);
    const join = (bots: unknown) => parseClientMessage(json({ type: 'join', roomId: ROOM, name: 'Ada', bots }));
    expect(join(100)).toEqual({ type: 'join', roomId: ROOM, name: 'Ada', bots: 100 });
    expect(join(1)).toMatchObject({ bots: 1 });
    for (const bad of [0, -1, 101, 2.5, '10', null]) {
      expect(join(bad)).toEqual({ type: 'join', roomId: ROOM, name: 'Ada' });
    }
  });

  test('keeps a valid join avatar and drops an invalid one', () => {
    expect(parseClientMessage(json({ type: 'join', roomId: ROOM, name: 'Ada', avatar: AVATAR }))).toEqual({
      type: 'join',
      roomId: ROOM,
      name: 'Ada',
      avatar: AVATAR,
    });
    expect(
      parseClientMessage(json({ type: 'join', roomId: ROOM, name: 'Ada', resumeToken: 't', avatar: 'nope' }))
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

const peer: PeerInfo = {
  id: 'p1',
  slot: 0,
  name: 'Ada',
  color: '#e6194b',
  x: 1,
  y: 2,
  angle: 0,
  cam: true,
  mic: false,
  avatar: null,
  held: null,
  boombox: false,
};

describe('parseServerMessage', () => {
  const samples: ServerMessage[] = [
    {
      type: 'welcome',
      selfId: 'p2',
      resumeToken: 't',
      color: '#3cb44b',
      spawn: { x: 1, y: 2, angle: 0 },
      peers: [peer],
      livekit: { url: 'wss://lk.example', token: 'jwt' },
      objects: [{ id: 'v', kind: 'vacuum', x: 3, y: 4, angle: 1 }],
    },
    { type: 'object_state', id: 'v', x: 1, y: 2, angle: 3, seq: 4, event: 'lost' },
    { type: 'peer_media', id: 'p1', cam: false, mic: true },
    { type: 'peer_joined', peer },
    { type: 'peer_joined', peer: { ...peer, avatar: AVATAR_ID } },
    { type: 'peer_joined', peer: { ...peer, held: 'wine' } },
    { type: 'peer_held', id: 'p1', item: 'beer' },
    { type: 'peer_held', id: 'p1', item: null },
    { type: 'peer_drink', id: 'p1' },
    { type: 'peer_left', id: 'p1' },
    { type: 'peers', s: [[0, 1, 2, 3]] },
    { type: 'error', code: 'outdated', message: 'zoom3d was updated: reload the page' },
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
    expect(parseServerMessage(json({ type: 'peer_joined', peer: { ...peer, avatar: 'javascript:x' } }))).toEqual({
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

describe('held items', () => {
  test('sip constants', () => {
    expect(SIP_MS).toBe(1400);
    expect(DRINK_GAP_MS).toBe(1000);
  });

  test('client drink parses with extra fields dropped', () => {
    expect(parseClientMessage(json({ type: 'drink', x: 1 }))).toEqual({ type: 'drink' });
  });

  test('peer_drink without an id is rejected', () => {
    expect(parseServerMessage(json({ type: 'peer_drink' }))).toBeNull();
  });

  test('a cheers lasts 1.6 s', () => {
    expect(CHEERS_MS).toBe(1600);
  });

  test('cheers parses and drops extra fields', () => {
    expect(parseClientMessage(json({ type: 'cheers', x: 1 }))).toEqual({ type: 'cheers' });
  });

  test('peer_cheers needs a string id', () => {
    expect(parseServerMessage(json({ type: 'peer_cheers', id: 'a' }))).toEqual({ type: 'peer_cheers', id: 'a' });
    expect(parseServerMessage(json({ type: 'peer_cheers', id: 5 }))).toBeNull();
  });

  test('isHeldItem accepts only the listed items', () => {
    expect(HELD_ITEMS).toEqual(['beer', 'coffee', 'wine']);
    for (const item of HELD_ITEMS) {
      expect(isHeldItem(item)).toBe(true);
    }
    for (const v of ['pizza', '', null, undefined, 1, 'Beer']) {
      expect(isHeldItem(v)).toBe(false);
    }
  });

  test('client held accepts null or an item and strips extra fields', () => {
    expect(parseClientMessage(json({ type: 'held', item: 'coffee', x: 1 }))).toEqual({ type: 'held', item: 'coffee' });
    expect(parseClientMessage(json({ type: 'held', item: null }))).toEqual({ type: 'held', item: null });
  });

  test('client held rejects unknown, non-string and missing items', () => {
    expect(parseClientMessage(json({ type: 'held', item: 'pizza' }))).toBeNull();
    expect(parseClientMessage(json({ type: 'held', item: 3 }))).toBeNull();
    expect(parseClientMessage(json({ type: 'held' }))).toBeNull();
  });

  test('peer_held with an unknown item (newer server) parses as null', () => {
    expect(parseServerMessage(json({ type: 'peer_held', id: 'p1', item: 'pizza' }))).toEqual({
      type: 'peer_held',
      id: 'p1',
      item: null,
    });
    expect(parseServerMessage(json({ type: 'peer_held', item: 'beer' }))).toBeNull();
  });

  test('a peer without held (older server) or with an unknown held parses with held null', () => {
    const { held: _omit, ...older } = peer;
    expect(parseServerMessage(json({ type: 'peer_joined', peer: older }))).toEqual({
      type: 'peer_joined',
      peer: { ...peer, held: null },
    });
    expect(parseServerMessage(json({ type: 'peer_joined', peer: { ...peer, held: 'pizza' } }))).toEqual({
      type: 'peer_joined',
      peer: { ...peer, held: null },
    });
  });
});

describe('media messages', () => {
  test('client media is accepted with booleans only', () => {
    expect(parseClientMessage(json({ type: 'media', cam: true, mic: false, x: 1 }))).toEqual({
      type: 'media',
      cam: true,
      mic: false,
    });
    expect(parseClientMessage(json({ type: 'media', cam: 'yes', mic: false }))).toBeNull();
  });

  test('WebRTC signalling is gone: LiveKit carries it (LiveKit spec §3)', () => {
    const offer = { kind: 'description', description: { type: 'offer', sdp: 'v=0' } };
    expect(parseClientMessage(json({ type: 'signal', to: 'p2', payload: offer }))).toBeNull();
    expect(parseServerMessage(json({ type: 'signal', from: 'p2', payload: offer }))).toBeNull();
  });

  test('rejects a welcome without a usable livekit url and token, or with a peer without cam', () => {
    const base = {
      type: 'welcome',
      selfId: 'p2',
      resumeToken: 't',
      color: '#3cb44b',
      spawn: { x: 1, y: 2, angle: 0 },
      peers: [] as unknown[],
      livekit: { url: 'wss://lk.example', token: 'jwt' },
    };
    expect(parseServerMessage(json(base))).not.toBeNull();
    for (const livekit of [
      undefined,
      null,
      { url: 'wss://lk' },
      { url: 'wss://lk', token: 5 },
      { url: '', token: 'jwt' },
    ]) {
      expect(parseServerMessage(json({ ...base, livekit }))).toBeNull();
    }
    const noCam = { id: 'a', name: 'A', color: '#fff', x: 1, y: 1, angle: 0, mic: true };
    expect(parseServerMessage(json({ ...base, peers: [noCam] }))).toBeNull();
  });
});

describe('boombox', () => {
  test('client boombox parses strictly', () => {
    expect(parseClientMessage(json({ type: 'boombox', on: true }))).toEqual({ type: 'boombox', on: true });
    expect(parseClientMessage(json({ type: 'boombox', on: false, x: 1 }))).toEqual({ type: 'boombox', on: false });
    for (const bad of [{ type: 'boombox' }, { type: 'boombox', on: 1 }, { type: 'boombox', on: 'yes' }]) {
      expect(parseClientMessage(json(bad))).toBeNull();
    }
  });

  test('peer_boombox parses leniently and needs an id', () => {
    expect(parseServerMessage(json({ type: 'peer_boombox', id: 'p1', on: true }))).toEqual({
      type: 'peer_boombox',
      id: 'p1',
      on: true,
    });
    expect(parseServerMessage(json({ type: 'peer_boombox', id: 'p1', on: 'loud' }))).toEqual({
      type: 'peer_boombox',
      id: 'p1',
      on: false,
    });
    expect(parseServerMessage(json({ type: 'peer_boombox', on: true }))).toBeNull();
  });

  test('PeerInfo.boombox is true only when the server says true', () => {
    const { boombox: _omit, ...older } = peer;
    const parsed = (p: unknown) =>
      (parseServerMessage(json({ type: 'peer_joined', peer: p })) as { peer: PeerInfo }).peer;
    expect(parsed(older).boombox).toBe(false);
    expect(parsed({ ...peer, boombox: 'yes' }).boombox).toBe(false);
    expect(parsed({ ...peer, boombox: true }).boombox).toBe(true);
  });
});

describe('world objects', () => {
  const welcome = {
    type: 'welcome',
    selfId: 'p2',
    resumeToken: 't',
    color: '#3cb44b',
    spawn: { x: 1, y: 2, angle: 0 },
    peers: [],
    livekit: { url: 'wss://lk.example', token: 'jwt' },
  };
  const vacuum = { id: 'v', kind: 'vacuum', x: 1, y: 2, angle: 0 };

  test('welcome without objects parses with objects: []', () => {
    expect(parseServerMessage(json(welcome))).toEqual({ ...welcome, objects: [] });
  });

  test('welcome keeps valid objects and drops invalid ones', () => {
    const objects = [vacuum, { ...vacuum, id: 'w', kind: 'toaster' }, { id: 3 }];
    expect(parseServerMessage(json({ ...welcome, objects }))).toEqual({ ...welcome, objects: [vacuum] });
  });

  test('object_state parses with and without event', () => {
    const state = { type: 'object_state', id: 'v', x: 1, y: 2, angle: 0.5, seq: 3 };
    expect(parseServerMessage(json(state))).toEqual(state);
    expect(parseServerMessage(json({ ...state, event: 'bump' }))).toEqual({ ...state, event: 'bump' });
  });

  test('object_state with an unknown event keeps the pose', () => {
    const state = { type: 'object_state', id: 'v', x: 1, y: 2, angle: 0.5, seq: 3 };
    expect(parseServerMessage(json({ ...state, event: 'dance' }))).toEqual(state);
  });

  test('object_state rejects a bad pose or seq', () => {
    const state = { type: 'object_state', id: 'v', x: 1, y: 2, angle: 0.5, seq: 3 };
    expect(parseServerMessage(json({ ...state, x: '1' }))).toBeNull();
    expect(parseServerMessage(json({ ...state, seq: -1 }))).toBeNull();
  });
});

describe('server fan-out (6d)', () => {
  test('constants', () => {
    expect(FANOUT_TICK_MS).toBe(66);
    expect(NEAR_TILES).toBe(16);
    expect(FAR_INTERVAL_MS).toBe(500);
    expect(MAX_PEERS).toBe(128);
    expect(PROTOCOL_VERSION).toBe(2);
  });

  test('peerEntry rounds positions to 0.01 tile and the angle to 0.001 rad', () => {
    expect(peerEntry(3, 1.23456, 2.5, 0.12345)).toEqual([3, 1.23, 2.5, 0.123]);
    expect(peerEntry(0, 7.006, 0.004, 6.2834)).toEqual([0, 7.01, 0, 6.283]);
  });

  test('peers keeps good entries and drops malformed ones', () => {
    const raw =
      '{"type":"peers","s":[[1,2,3,0.5],[1.5,2,3,0],[-1,2,3,0],[2,"2",3,0],[3,2,3],[4,2,3,0,9],5,[5,1e999,3,0],[6,0,0,0]]}';
    expect(parseServerMessage(raw)).toEqual({
      type: 'peers',
      s: [
        [1, 2, 3, 0.5],
        [6, 0, 0, 0],
      ],
    });
  });

  test('peers without an entry array is rejected', () => {
    expect(parseServerMessage(json({ type: 'peers' }))).toBeNull();
    expect(parseServerMessage(json({ type: 'peers', s: {} }))).toBeNull();
  });

  test('peer_state is gone from the protocol', () => {
    expect(parseServerMessage(json({ type: 'peer_state', id: 'p1', x: 1, y: 2, angle: 3, seq: 4 }))).toBeNull();
  });

  test('a peer needs a whole, non-negative slot', () => {
    for (const slot of [undefined, -1, 1.5, '1']) {
      expect(parseServerMessage(json({ type: 'peer_joined', peer: { ...peer, slot } }))).toBeNull();
    }
    expect(parseServerMessage(json({ type: 'peer_joined', peer: { ...peer, slot: 41 } }))).toEqual({
      type: 'peer_joined',
      peer: { ...peer, slot: 41 },
    });
  });

  test('a peer avatar is an avatar id; a data URL (older server) reads as null', () => {
    expect(isAvatarId(AVATAR_ID)).toBe(true);
    for (const bad of [AVATAR, 'short', `${AVATAR_ID}x`, 'abcdefghijklmnopqrstu/', 5, null]) {
      expect(isAvatarId(bad)).toBe(false);
    }
    expect(parseServerMessage(json({ type: 'peer_joined', peer: { ...peer, avatar: AVATAR } }))).toEqual({
      type: 'peer_joined',
      peer: { ...peer, avatar: null },
    });
    expect(avatarPath(AVATAR_ID)).toBe(`/avatar/${AVATAR_ID}`);
  });

  test('a join keeps a whole protocol version of at least 1 and drops anything else', () => {
    const join = (v: unknown) => parseClientMessage(json({ type: 'join', roomId: ROOM, name: 'Ada', v }));
    expect(join(2)).toEqual({ type: 'join', roomId: ROOM, name: 'Ada', v: 2 });
    expect(join(1)).toMatchObject({ v: 1 });
    for (const bad of [0, -2, 1.5, '2', null]) {
      expect(join(bad)).toEqual({ type: 'join', roomId: ROOM, name: 'Ada' });
    }
  });
});
