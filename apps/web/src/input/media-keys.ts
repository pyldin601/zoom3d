// Room hotkeys for the mic and camera: M mutes or unmutes, C turns the camera off or on (the map is Tab).
import { isTextEntry } from './keyboard';

const MEDIA_KEYS: Record<string, 'mic' | 'cam'> = { KeyM: 'mic', KeyC: 'cam' };

/** Which room-bar toggle a key press means, if any. Repeats, shortcuts (Cmd+C) and typing don't count. */
export function mediaKey(e: KeyboardEvent): 'mic' | 'cam' | null {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) {
    return null;
  }
  return MEDIA_KEYS[e.code] ?? null;
}
