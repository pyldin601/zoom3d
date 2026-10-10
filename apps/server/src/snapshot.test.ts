import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PEERS } from '@zoom3d/shared';
import { beforeEach, expect, test, vi } from 'vitest';
import type { LobbySnapshot, SnapshotPeer } from './lobby';
import { silentLogger } from './log';
import { loadSnapshot, parseSnapshot, saveSnapshot } from './snapshot';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const peer = (id: string, extra: Partial<SnapshotPeer> = {}): SnapshotPeer => ({
  id,
  name: id,
  color: '#fff',
  x: 1.5,
  y: 2.5,
  angle: 0,
  cam: false,
  mic: true,
  avatar: null,
  held: 'coffee',
  boombox: false,
  resumeToken: `tok-${id}`,
  lastAcceptedAt: 1000,
  ...extra,
});
const snap = (peers: unknown[], id = ROOM) => JSON.stringify({ version: 1, rooms: [{ id, peers }] });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zoom3d-snapshot-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

test('a valid snapshot parses unchanged', () => {
  const s: LobbySnapshot = { version: 1, rooms: [{ id: ROOM, peers: [peer('a'), peer('b')] }] };
  expect(parseSnapshot(JSON.stringify(s))).toEqual(s);
});

test('garbage and other versions are rejected', () => {
  expect(parseSnapshot('not json')).toBeNull();
  expect(parseSnapshot('null')).toBeNull();
  expect(parseSnapshot('{"version":1}')).toBeNull();
  expect(parseSnapshot(JSON.stringify({ version: 2, rooms: [] }))).toBeNull();
});

test('invalid peers are dropped, and rooms left empty, oversized or with a bad id go too', () => {
  const kept = parseSnapshot(
    snap([peer('a'), { ...peer('b'), resumeToken: 5 }, { ...peer('c'), lastAcceptedAt: null }])
  );
  expect(kept?.rooms[0]?.peers.map((p) => p.id)).toEqual(['a']);
  expect(parseSnapshot(snap([{ ...peer('b'), cam: 'yes' }]))?.rooms).toEqual([]);
  expect(parseSnapshot(snap([peer('a')], 'bad id'))?.rooms).toEqual([]);
  const crowd = Array.from({ length: MAX_PEERS + 1 }, (_, i) => peer(`p${i}`));
  expect(parseSnapshot(snap(crowd))?.rooms).toEqual([]);
});

test('fields missing from an older snapshot read as their defaults', () => {
  const { held: _held, boombox: _boombox, ...old } = peer('a');
  expect(parseSnapshot(snap([old]))?.rooms[0]?.peers[0]).toMatchObject({ held: null, boombox: false });
});

test('save then load round-trips, and loading consumes the file', () => {
  const path = join(dir, 'lobby.json');
  const s: LobbySnapshot = { version: 1, rooms: [{ id: ROOM, peers: [peer('a')] }] };
  saveSnapshot(path, s, silentLogger);
  expect(readdirSync(dir)).toEqual(['lobby.json']);
  expect(loadSnapshot(path, silentLogger)).toEqual(s);
  expect(existsSync(path)).toBe(false);
  expect(loadSnapshot(path, silentLogger)).toBeNull();
});

test('a corrupt file loads as nothing, without throwing, and is consumed', () => {
  const path = join(dir, 'lobby.json');
  writeFileSync(path, '{"version":1,"rooms":[');
  expect(loadSnapshot(path, silentLogger)).toBeNull();
  expect(existsSync(path)).toBe(false);
});

test('a failed save is logged, not thrown', () => {
  const errors: string[] = [];
  const log = { ...silentLogger, error: (msg: string) => errors.push(msg) };
  expect(() => saveSnapshot(join(dir, 'missing', 'lobby.json'), { version: 1, rooms: [] }, log)).not.toThrow();
  expect(errors).toEqual(['snapshot_write_failed']);
});
