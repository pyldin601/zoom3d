import { isValidRoomId } from '@zoom3d/shared';

export type Route = { kind: 'landing' } | { kind: 'room'; roomId: string } | { kind: 'invalid' };

export function parseRoute(pathname: string): Route {
  if (pathname === '/') {
    return { kind: 'landing' };
  }
  const match = /^\/r\/([^/]*)\/?$/.exec(pathname);
  return match && isValidRoomId(match[1]) ? { kind: 'room', roomId: match[1] } : { kind: 'invalid' };
}
