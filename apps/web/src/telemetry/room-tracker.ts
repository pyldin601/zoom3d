// Turns the session's connection status changes into join / drop / leave analytics events. Fed by session listener
// callbacks, not the render loop, so drops while the tab is hidden still count.
import type { ConnStatus } from '../net/connection';
import type { Session, SessionListener } from '../net/session';
import type { AnalyticsEvent } from './analytics';

export interface RoomTracker {
  /** The session's status changed (a repeat is ignored); `peers` and `error` as the session has them now. */
  update(status: ConnStatus, peers: number, error: string | null): void;
  /** The room's size changed: keeps the largest seen. */
  peers(n: number): void;
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
    peers(n) {
      if (n > peersMax) {
        peersMax = n;
      }
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

/** Feeds `tracker` from a session's listener callbacks. The session is read lazily: it exists by the first callback. */
export function withRoomTracker(
  listener: SessionListener,
  tracker: RoomTracker,
  session: () => Session | null
): SessionListener {
  return {
    ...listener,
    status(s) {
      listener.status?.(s);
      const current = session();
      tracker.update(s, current?.peers.size ?? 0, current?.error() ?? null);
    },
    peerJoined(peer) {
      listener.peerJoined?.(peer);
      tracker.peers(session()?.peers.size ?? 0);
    },
  };
}
