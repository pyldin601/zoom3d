// Turns the session's connection status, sampled every frame, into join / drop / leave analytics events.
import type { ConnStatus } from '../net/connection';
import type { AnalyticsEvent } from './analytics';

export interface RoomTracker {
  /** Called every frame: compares and counts, allocates only when it reports something. */
  update(status: ConnStatus, peers: number, error: string | null): void;
  /** The tab is going away: reports how the visit went, once. */
  leave(): void;
}

export function createRoomTracker(track: (e: AnalyticsEvent) => void, now: () => number): RoomTracker {
  let last: ConnStatus = 'connecting';
  let joinedAt: number | null = null;
  let lostAt = 0;
  let peersMax = 0;
  let drops = 0;
  let done = false;

  return {
    update(status, peers, error) {
      if (status === 'open' && peers > peersMax) {
        peersMax = peers;
      }
      if (status === last || done) {
        return;
      }
      if (status === 'open' && joinedAt === null) {
        joinedAt = now();
        track({ name: 'room_joined', peers });
      } else if (status === 'open' && last === 'reconnecting') {
        track({ name: 'connection_restored', downS: Math.round((now() - lostAt) / 1000) });
      } else if (status === 'reconnecting' && joinedAt !== null) {
        lostAt = now();
        drops++;
        track({ name: 'connection_lost' });
      } else if (status === 'failed') {
        track({ name: 'connection_failed', reason: error ?? 'unknown', joined: joinedAt !== null });
      }
      last = status;
    },
    leave() {
      if (joinedAt === null || done) {
        return;
      }
      done = true;
      track({ name: 'room_left', durationS: Math.round((now() - joinedAt) / 1000), peersMax, drops });
    },
  };
}
