// Dynamic subscription (6c spec §4.2): which faces and voices this client wants, from what the frame drew, where
// people are and the audio range. Pure apart from its memory of current wants (for holds and hysteresis).
import { type GameMap, hasLineOfSight, type PlayerState } from '@zoom3d/shared';

export type VideoWant = 'off' | 64 | 128 | 256;

export interface Want {
  video: VideoWant;
  audio: boolean;
}

/** Receive nothing from a peer: no face, no voice, no boombox. */
export const WANT_NONE: Readonly<Want> = { video: 'off', audio: false };

/** Written by the renderer's sprite pass each frame. */
export interface PeerFacts {
  /** Disc columns seen: in front of the walls and not behind a nearer disc (0 = not on screen, or fully hidden). */
  drawnColumns: number;
  /** The disc's diameter in framebuffer pixels. */
  projectedSize: number;
}

export interface InterestPeer {
  id: string;
  x: number;
  y: number;
  sees?: boolean;
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
  /** Where each appears to the player; `sees`, when given, is the line of sight (through portals). */
  peers: readonly InterestPeer[];
  facts: (id: string) => PeerFacts | undefined;
}

export const INTEREST_MS = 250;
export const HOLD_MS = 1000;
export const LOOKAHEAD_TILES = 20;
export const LOOKAHEAD_DEG = 15;
/** The smallest drawn face (framebuffer px) received at 256, and at 128; smaller ones get 64. */
export const FACE_256_MIN_PX = 128;
export const FACE_128_MIN_PX = 48;
/** A size is kept until the face shrinks this far below its threshold. */
const HYSTERESIS = 0.8;
export const AUDIO_ON_MARGIN_TILES = 2;
export const AUDIO_OFF_MARGIN_TILES = 4;
export const MAX_VIDEOS = 12;
export const MAX_VOICES = 24;

const LOOKAHEAD_RAD = (LOOKAHEAD_DEG * Math.PI) / 180;
const RANK: Record<VideoWant, number> = { off: 0, 64: 1, 128: 2, 256: 3 };

interface State {
  video: VideoWant;
  audio: boolean;
  /** Since when a lower video than `video` has been wanted without a break; null when it isn't. */
  lowerSince: number | null;
}

interface Candidate {
  id: string;
  state: State;
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
  if (projected >= FACE_256_MIN_PX || keep(256, FACE_256_MIN_PX)) {
    return 256;
  }
  if (projected >= FACE_128_MIN_PX || keep(128, FACE_128_MIN_PX)) {
    return 128;
  }
  return 64;
}

export function createInterest(): { update(input: InterestInput): ReadonlyMap<string, Want> } {
  const states = new Map<string, State>();

  function target(input: InterestInput, peer: InterestPeer, distance: number, s: State) {
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
    const sees = peer.sees ?? hasLineOfSight(input.map, player.x, player.y, peer.x, peer.y);
    return sees ? 64 : 'off';
  }

  /** Everyone listed, with what they'd get with no caps, nearest first; forgets anyone no longer listed. */
  function candidatesFor(input: InterestInput): Candidate[] {
    const { player, maxDistance } = input;
    const listed = new Set<string>();
    const candidates: Candidate[] = [];
    for (const peer of input.peers) {
      listed.add(peer.id);
      let state = states.get(peer.id);
      if (!state) {
        state = { video: 'off', audio: false, lowerSince: null };
        states.set(peer.id, state);
      }
      const distance = Math.hypot(peer.x - player.x, peer.y - player.y);
      const audio = distance <= maxDistance + (state.audio ? AUDIO_OFF_MARGIN_TILES : AUDIO_ON_MARGIN_TILES);
      candidates.push({ id: peer.id, state, distance, video: target(input, peer, distance, state), audio });
    }
    for (const id of states.keys()) {
      if (!listed.has(id)) {
        states.delete(id);
      }
    }
    return candidates.sort((a, b) => a.distance - b.distance);
  }

  /** A bigger face is taken at once; a smaller one only after it has been wanted for HOLD_MS (hidden: at once). */
  function settleVideo(state: State, video: VideoWant, input: InterestInput): void {
    if (input.hidden || RANK[video] >= RANK[state.video]) {
      state.video = video;
      state.lowerSince = null;
    } else if (state.lowerSince === null) {
      state.lowerSince = input.now;
    } else if (input.now - state.lowerSince >= HOLD_MS) {
      state.video = video;
      state.lowerSince = null;
    }
  }

  return {
    update(input) {
      let videos = 0;
      let voices = 0;
      const out = new Map<string, Want>();
      // The nearest MAX_VIDEOS faces and MAX_VOICES voices win.
      for (const c of candidatesFor(input)) {
        const video = c.video !== 'off' && ++videos > MAX_VIDEOS ? 'off' : c.video;
        const audio = c.audio && ++voices <= MAX_VOICES;
        settleVideo(c.state, video, input);
        c.state.audio = audio;
        out.set(c.id, { video: c.state.video, audio });
      }
      return out;
    },
  };
}
