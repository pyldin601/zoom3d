// The room's status line: nothing while connected, else what the connection is doing or why it failed.
import { type ErrorCode, MAX_PEERS } from '@zoom3d/shared';
import type { ConnStatus } from '../net/connection';
import { showPeopleCount, showStatus } from './screens';

/** The room's status line and head count; null hides each. */
export interface StatusLine {
  show(status: string | null, people: number | null): void;
}

/** Writes to the page only what changed: the room loop calls it every frame. */
export function createStatusLine(ui: HTMLElement): StatusLine {
  let shownStatus: string | null = null;
  let shownPeople: number | null = null;
  return {
    show(status, people) {
      if (status !== shownStatus) {
        showStatus(ui, status);
        shownStatus = status;
      }
      if (people !== shownPeople) {
        showPeopleCount(ui, people);
        shownPeople = people;
      }
    },
  };
}

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
