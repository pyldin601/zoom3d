import { describe, expect, test } from 'vitest';
import {
  isValidRoomId,
  MAX_MESSAGE_BYTES,
  newRoomId,
  type PeerInfo,
  parseClientMessage,
  parseServerMessage,
  type ServerMessage,
  sanitizeName,
} from './protocol';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const json = (v: unknown) => JSON.stringify(v);

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
  const peer: PeerInfo = { id: 'p1', name: 'Ada', color: '#e6194b', x: 1, y: 2, angle: 0 };
  const samples: ServerMessage[] = [
    {
      type: 'welcome',
      selfId: 'p2',
      resumeToken: 't',
      color: '#3cb44b',
      spawn: { x: 1, y: 2, angle: 0 },
      peers: [peer],
    },
    { type: 'peer_joined', peer },
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

  test('rejects unknown error codes', () => {
    expect(parseServerMessage(json({ type: 'error', code: 'boom', message: '' }))).toBeNull();
  });
});
