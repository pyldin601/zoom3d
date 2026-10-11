import { isValidRoomId, MAX_BOTS } from '@zoom3d/shared';

export type Route = { kind: 'landing' } | { kind: 'room'; roomId: string } | { kind: 'invalid' };

export function parseRoute(pathname: string): Route {
  if (pathname === '/') {
    return { kind: 'landing' };
  }
  const match = /^\/r\/([^/]*)\/?$/.exec(pathname);
  return match && isValidRoomId(match[1]) ? { kind: 'room', roomId: match[1] } : { kind: 'invalid' };
}

/** `?bots=N` (1..MAX_BOTS): a room created from this link gets N wandering bots, for testing large rooms. */
export function botsParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('bots');
  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return n >= 1 && n <= MAX_BOTS ? n : null;
}
