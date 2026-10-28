// The room's one-key shortcuts besides walking (keyboard.ts): ` the console, Tab the map, B the boombox (spec §3),
// 0–3 the drinks (held items spec §2.4), M and C the mic and camera (media-keys.ts), Space the kick (ball spec §7),
// Y the portals (portal doorways spec §2.1).
// Pure: main.ts listens and acts.
import type { HeldItem } from '@zoom3d/shared';
import { heldForKey } from '../ui/held-store';
import { mediaKey } from './media-keys';

export type RoomKey =
  | { kind: 'console' }
  /** A held Tab repeats: it still mustn't move the focus, but the map only flips on the first press. */
  | { kind: 'map'; repeat: boolean }
  | { kind: 'boombox' }
  /** `code` is the key's, for its release. */
  | { kind: 'drink'; item: HeldItem | null; code: string }
  | { kind: 'media'; control: 'mic' | 'cam' }
  | { kind: 'kick' }
  | { kind: 'portals' };

export interface RoomKeyState {
  /** In the room and connected; only the boombox key works while reconnecting (the music is local). */
  inRoom: boolean;
  hasBoombox: boolean;
}

type KeyEvent = Pick<KeyboardEvent, 'code' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>;

/** What a key press in the room means, if anything. */
export function roomKey(e: KeyEvent, state: RoomKeyState): RoomKey | null {
  // A focused <input> (the console's sliders) keeps its keys. The console's <select> doesn't, so ` still closes it.
  if (inInput(e.target)) {
    return null;
  }
  const shortcut = e.metaKey || e.ctrlKey || e.altKey;
  if (e.code === 'KeyB') {
    return state.hasBoombox && !e.repeat && !shortcut ? { kind: 'boombox' } : null;
  }
  if (!state.inRoom) {
    return null;
  }
  // Outside the room Tab keeps its keyboard-navigation meaning.
  if (e.code === 'Tab') {
    return { kind: 'map', repeat: e.repeat };
  }
  if (e.code === 'Backquote') {
    return e.repeat ? null : { kind: 'console' };
  }
  // A focused button or select would take Space as a press of its own.
  if (e.code === 'Space') {
    return e.repeat || shortcut || isFormControl(e.target) ? null : { kind: 'kick' };
  }
  if (e.code === 'KeyY') {
    return e.repeat || shortcut ? null : { kind: 'portals' };
  }
  const item = heldForKey(e.code);
  if (item !== undefined) {
    return e.repeat || shortcut ? null : { kind: 'drink', item, code: e.code };
  }
  const control = mediaKey(e);
  return control ? { kind: 'media', control } : null;
}

function inInput(target: EventTarget | null): boolean {
  return (target as { tagName?: string } | null)?.tagName === 'INPUT';
}

const FORM_CONTROLS = ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'];

function isFormControl(target: EventTarget | null): boolean {
  return FORM_CONTROLS.includes((target as { tagName?: string } | null)?.tagName ?? '');
}
