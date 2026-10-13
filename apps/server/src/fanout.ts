// Which peers' poses go to one recipient this tick (6d spec §2.1). Pure: the lobby owns the clock and the sockets.
import { FAR_INTERVAL_MS, NEAR_TILES, type PeerEntry, peerEntry } from '@zoom3d/shared';

/** A peer whose pose may be sent: `poseVersion` changes whenever its pose does, `poseAt` is when it last did. */
export interface Subject {
  id: string;
  slot: number;
  x: number;
  y: number;
  angle: number;
  poseVersion: number;
  poseAt: number;
}

/** Per recipient: for each other peer, the pose version last sent to it and when. */
export type SentLog = Map<string, { version: number; at: number }>;

/**
 * The changed poses `self` should get now: near peers (within NEAR_TILES, walls ignored) every tick, the rest at most
 * every FAR_INTERVAL_MS. Records what it picks in `sent`.
 */
export function selectBatch(
  self: { id: string; x: number; y: number },
  subjects: Iterable<Subject>,
  sent: SentLog,
  now: number
): PeerEntry[] {
  const out: PeerEntry[] = [];
  for (const s of subjects) {
    if (s.id === self.id) {
      continue;
    }
    const last = sent.get(s.id);
    if (last && last.version === s.poseVersion) {
      continue;
    }
    const near = Math.hypot(s.x - self.x, s.y - self.y) <= NEAR_TILES;
    if (last && !near && now - last.at < FAR_INTERVAL_MS) {
      continue;
    }
    out.push(peerEntry(s.slot, s.x, s.y, s.angle, now - s.poseAt));
    if (last) {
      last.version = s.poseVersion;
      last.at = now;
    } else {
      sent.set(s.id, { version: s.poseVersion, at: now });
    }
  }
  return out;
}
