// The room's status line: nothing while connected, else what the connection is doing or why it failed.
import { type ErrorCode, MAX_PEERS } from '@zoom3d/shared';
import type { ConnStatus } from '../net/connection';

export function statusText(status: ConnStatus, error: ErrorCode | null): string | null {
  switch (status) {
    case 'open':
      return null;
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'failed':
      switch (error) {
        case 'room_full':
          return `This room is full (${MAX_PEERS} people)`;
        case 'outdated':
          return 'zoom3d was updated: reload the page';
        default:
          return "Couldn't join this room";
      }
  }
}
