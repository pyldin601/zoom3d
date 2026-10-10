// The lobby written on shutdown and read back on the next start, so a deploy doesn't drop the rooms.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isValidRoomId, MAX_PEERS, parsePeerInfo } from '@zoom3d/shared';
import type { LobbySnapshot, SnapshotPeer } from './lobby';
import type { Logger } from './log';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function snapshotPeer(v: unknown): SnapshotPeer | null {
  const info = parsePeerInfo(v);
  if (!info || !isObj(v) || typeof v.resumeToken !== 'string' || !Number.isFinite(v.lastAcceptedAt)) {
    return null;
  }
  return { ...info, resumeToken: v.resumeToken, lastAcceptedAt: v.lastAcceptedAt as number };
}

/** Invalid peers are dropped, then any room left empty, oversized or with a bad id. */
export function parseSnapshot(raw: string): LobbySnapshot | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.rooms)) {
    return null;
  }
  const rooms: LobbySnapshot['rooms'] = [];
  for (const r of v.rooms) {
    if (!isObj(r) || !isValidRoomId(r.id) || !Array.isArray(r.peers)) {
      continue;
    }
    const peers = r.peers.map(snapshotPeer).filter((p) => p !== null);
    if (peers.length > 0 && peers.length <= MAX_PEERS) {
      rooms.push({ id: r.id, peers });
    }
  }
  return { version: 1, rooms };
}

/** Reads and deletes the file, so a later crash can't bring back an old shutdown's rooms. Never throws. */
export function loadSnapshot(path: string, log: Logger): LobbySnapshot | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('snapshot_read_failed', { path, err });
    }
    return null;
  }
  try {
    rmSync(path, { force: true });
  } catch (err) {
    log.warn('snapshot_delete_failed', { path, err });
  }
  const snap = parseSnapshot(raw);
  if (!snap) {
    log.warn('snapshot_unreadable', { path });
  }
  return snap;
}

/** Writes through a temp file and a rename, so a kill mid-write leaves no half file. Never throws. */
export function saveSnapshot(path: string, snap: LobbySnapshot, log: Logger): void {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, path);
  } catch (err) {
    log.error('snapshot_write_failed', { path, err });
    return;
  }
  const peers = snap.rooms.reduce((n, r) => n + r.peers.length, 0);
  log.info('snapshot_saved', { path, rooms: snap.rooms.length, peers });
}
