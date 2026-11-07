// Stepping on and off kick scooters (kick scooter spec §4.3): E or the touch button asks the server, and only its
// answer, the session's `riding`, puts the local player on one. Read every frame, so it allocates nothing.
import { canMount, type Point } from '@zoom3d/shared';
import { objectKey, type Session } from '../net/session';

export type RideSession = Pick<Session, 'riding' | 'objects' | 'sendRide' | 'sendDismount'>;

export interface ScooterRide {
  /**
   * Steps on the nearest parked scooter in reach, measured where things appeared in the last `inReach` (a key press
   * has no frame of its own), or off the ridden one.
   */
  toggle(player: Point): void;
  /**
   * On foot, with nothing asked for yet, and a parked scooter in reach: what shows the hint and the button. Called
   * every frame with where everything appears to the local player.
   */
  inReach(player: Point, apparent?: ReadonlyMap<string, Point>): boolean;
  /** The server answered the local player's ask. */
  settled(): void;
}

/** An unanswered ask (refused, or lost in a reconnect) stops blocking presses after this long. */
const RIDE_PENDING_MS = 1000;

export function createScooterRide(session: RideSession, now: () => number): ScooterRide {
  let askedAt = Number.NEGATIVE_INFINITY;
  let lastApparent: ReadonlyMap<string, Point> | undefined;
  /** Each scooter's objectKey, made once rather than every frame. */
  const keys = new Map<string, string>();
  const keyOf = (id: string) => {
    let key = keys.get(id);
    if (key === undefined) {
      key = objectKey(id);
      keys.set(id, key);
    }
    return key;
  };
  const pending = () => now() - askedAt < RIDE_PENDING_MS;

  /** The id of the nearest parked scooter within reach, by where it appears to the local player; null if none. */
  const nearest = (player: Point, apparent?: ReadonlyMap<string, Point>): string | null => {
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const { info } of session.objects.values()) {
      if (info.kind !== 'scooter') {
        continue;
      }
      const at = apparent?.get(keyOf(info.id)) ?? info;
      const distance = Math.hypot(at.x - player.x, at.y - player.y);
      if (distance < bestDistance && canMount(player, at)) {
        best = info.id;
        bestDistance = distance;
      }
    }
    return best;
  };

  return {
    toggle(player) {
      if (pending()) {
        return;
      }
      if (session.riding !== null) {
        session.sendDismount();
        askedAt = now();
        return;
      }
      const id = nearest(player, lastApparent);
      if (id !== null) {
        session.sendRide(id);
        askedAt = now();
      }
    },
    inReach(player, apparent) {
      lastApparent = apparent;
      return session.riding === null && !pending() && nearest(player, apparent) !== null;
    },
    settled() {
      askedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
