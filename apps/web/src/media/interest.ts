// Dynamic subscription (6c spec §4.2): which faces and voices this client wants, from what the frame drew, where
// people are and the audio range. Pure apart from its memory of current wants (for holds and hysteresis).
import { type GameMap, hasLineOfSight, type PlayerState } from '@zoom3d/shared';

export type VideoWant = 'off' | 64 | 128 | 256;

export interface Want {
  video: VideoWant;
  audio: boolean;
}

/** Written by the renderer's sprite pass each frame. */
export interface PeerFacts {
  /** Disc columns seen: in front of the walls and not behind a nearer disc (0 = not on screen, or fully hidden). */
  drawnColumns: number;
  /** The disc's diameter in framebuffer pixels. */
  projectedSize: number;
}

export interface InterestInput {
  now: number;
  hidden: boolean;
  player: PlayerState;
  /** Horizontal field of view, radians. */
  fov: number;
  map: GameMap;
  /** The audio settings' `max`: voices are silent beyond it. */
  maxDistance: number;
  peers: readonly { id: string; x: number; y: number }[];
  facts: (id: string) => PeerFacts | undefined;
}

export const INTEREST_MS = 250;
export const HOLD_MS = 1000;
export const LOOKAHEAD_TILES = 20;
export const LOOKAHEAD_DEG = 15;
/** Framebuffer px: at least this big → 256, else at least `SIZE_128` → 128, else 64. */
export const SIZE_256 = 128;
export const SIZE_128 = 48;
/** A size is kept until the face shrinks this far below its threshold. */
const HYSTERESIS = 0.8;
export const AUDIO_ON_MARGIN = 2;
export const AUDIO_OFF_MARGIN = 4;
export const MAX_VIDEOS = 12;
export const MAX_VOICES = 24;

const LOOKAHEAD_RAD = (LOOKAHEAD_DEG * Math.PI) / 180;
const RANK: Record<VideoWant, number> = { off: 0, 64: 1, 128: 2, 256: 3 };

interface State {
  video: VideoWant;
  audio: boolean;
  /** Since when a lower video than `video` has been wanted without a break; -1 when not. */
  lowerSince: number;
}

interface Candidate {
  id: string;
  distance: number;
  video: VideoWant;
  audio: boolean;
}

/** Wrapped to [-π, π]. */
function angleDiff(a: number, b: number): number {
  const d = (a - b) % (Math.PI * 2);
  return d > Math.PI ? d - Math.PI * 2 : d < -Math.PI ? d + Math.PI * 2 : d;
}

function sizeFor(projected: number, current: VideoWant): VideoWant {
  const keep = (size: VideoWant, threshold: number) =>
    RANK[current] >= RANK[size] && projected >= threshold * HYSTERESIS;
  if (projected >= SIZE_256 || keep(256, SIZE_256)) {
    return 256;
  }
  if (projected >= SIZE_128 || keep(128, SIZE_128)) {
    return 128;
  }
  return 64;
}

export function createInterest(): { update(input: InterestInput): ReadonlyMap<string, Want> } {
  const states = new Map<string, State>();

  function target(input: InterestInput, peer: { id: string; x: number; y: number }, distance: number, s: State) {
    if (input.hidden) {
      return 'off';
    }
    const facts = input.facts(peer.id);
    if (facts && facts.drawnColumns > 0) {
      return sizeFor(facts.projectedSize, s.video);
    }
    const { player } = input;
    if (distance > LOOKAHEAD_TILES) {
      return 'off';
    }
    const bearing = Math.atan2(peer.y - player.y, peer.x - player.x);
    const off = Math.abs(angleDiff(bearing, player.angle));
    if (off > input.fov / 2 + LOOKAHEAD_RAD) {
      return 'off';
    }
    // Look-ahead is for people just outside the view. Inside it, a frame that projected their disc but drew none of it
    // means they're hidden (behind someone nearer, or a wall). Too close to project (size 0) still counts as near.
    if (facts && facts.projectedSize > 0 && off <= input.fov / 2) {
      return 'off';
    }
    return hasLineOfSight(input.map, player.x, player.y, peer.x, peer.y) ? 64 : 'off';
  }

  return {
    update(input) {
      const { player, maxDistance } = input;
      const listed = new Set<string>();
      const candidates: Candidate[] = [];
      for (const peer of input.peers) {
        listed.add(peer.id);
        let s = states.get(peer.id);
        if (!s) {
          s = { video: 'off', audio: false, lowerSince: -1 };
          states.set(peer.id, s);
        }
        const distance = Math.hypot(peer.x - player.x, peer.y - player.y);
        const audio = distance <= maxDistance + (s.audio ? AUDIO_OFF_MARGIN : AUDIO_ON_MARGIN);
        candidates.push({ id: peer.id, distance, video: target(input, peer, distance, s), audio });
      }
      for (const id of states.keys()) {
        if (!listed.has(id)) {
          states.delete(id);
        }
      }

      candidates.sort((a, b) => a.distance - b.distance);
      let videos = 0;
      let voices = 0;
      const out = new Map<string, Want>();
      for (const c of candidates) {
        let video = c.video;
        if (video !== 'off' && ++videos > MAX_VIDEOS) {
          video = 'off';
        }
        const audio = c.audio && ++voices <= MAX_VOICES;
        const s = states.get(c.id) as State;
        if (input.hidden || RANK[video] >= RANK[s.video]) {
          s.video = video;
          s.lowerSince = -1;
        } else if (s.lowerSince < 0) {
          s.lowerSince = input.now;
        } else if (input.now - s.lowerSince >= HOLD_MS) {
          s.video = video;
          s.lowerSince = -1;
        }
        s.audio = audio;
        out.set(c.id, { video: s.video, audio });
      }
      return out;
    },
  };
}
