// Dynamic subscription's loop (6c spec §4): every INTEREST_MS the interest rule decides whose face and voice to
// receive, from where people are and what the last frame drew of them, and only the changes go to the call.
import type { GameMap, PlayerState, Point } from '@zoom3d/shared';
import type { Call } from './call';
import { createInterest, INTEREST_MS, type PeerFacts, type Want } from './interest';

export interface Surroundings {
  call: Pick<Call, 'publishes' | 'setWanted'>;
  /** The people in the room, by id: other keys in `positions` are world objects. */
  people: ReadonlyMap<string, unknown>;
  positions: ReadonlyMap<string, Point>;
  player: PlayerState;
  /** Radians. */
  fov: number;
  map: GameMap;
  /** Voices are silent beyond this many tiles. */
  maxDistance: number;
  hidden: boolean;
}

export interface Subscription {
  /** Per person, what the last frame drew of them: the renderer writes it into reused objects. */
  readonly seen: Map<string, PeerFacts>;
  /** Does nothing until INTEREST_MS have passed since it last chose. */
  choose(now: number, around: Surroundings): void;
}

export function createSubscription(): Subscription {
  const seen = new Map<string, PeerFacts>();
  const interest = createInterest();
  /** The wants last handed to `sentTo`. */
  const sent = new Map<string, Want>();
  let sentTo: Surroundings['call'] | null = null;
  let chosenAt = Number.NEGATIVE_INFINITY;

  const forgetUnseen = (positions: ReadonlyMap<string, Point>) => {
    for (const id of seen.keys()) {
      if (!positions.has(id)) {
        seen.delete(id);
      }
    }
  };

  /** Bots publish nothing: they must not take anyone's video or voice slot. */
  const peopleWithMedia = (around: Surroundings) => {
    const peers: { id: string; x: number; y: number }[] = [];
    for (const [id, pos] of around.positions) {
      if (around.people.has(id) && around.call.publishes(id)) {
        peers.push({ id, x: pos.x, y: pos.y });
      }
    }
    return peers;
  };

  const sendChanges = (call: Surroundings['call'], wants: ReadonlyMap<string, Want>) => {
    for (const [id, want] of wants) {
      const last = sent.get(id);
      if (!last || last.video !== want.video || last.audio !== want.audio) {
        sent.set(id, want);
        call.setWanted(id, want);
      }
    }
    for (const id of sent.keys()) {
      if (!wants.has(id)) {
        sent.delete(id);
      }
    }
  };

  return {
    seen,
    choose(now, around) {
      if (now - chosenAt < INTEREST_MS) {
        return;
      }
      chosenAt = now;
      if (around.call !== sentTo) {
        sentTo = around.call;
        sent.clear();
      }
      forgetUnseen(around.positions);
      const wants = interest.update({
        now,
        hidden: around.hidden,
        player: around.player,
        fov: around.fov,
        map: around.map,
        maxDistance: around.maxDistance,
        peers: peopleWithMedia(around),
        facts: (id) => seen.get(id),
      });
      sendChanges(around.call, wants);
    },
  };
}
