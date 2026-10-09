// The last face framing per camera, remembered per browser so a page reload starts on the face instead of the
// centre. Storage may be missing or throw.
import type { Rect } from './framing';

export const FRAMING_KEY = 'zoom3d.framing';

export interface FramingMemory {
  /** The rect saved for this camera at this frame size, or null. */
  load(camera: string, frameW: number, frameH: number): Rect | null;
  /** Called on each detection with a face; writes only when the rect changed. */
  save(camera: string, frameW: number, frameH: number, rect: Rect): void;
}

interface Saved extends Rect {
  w: number;
  h: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isSaved(v: unknown): v is Saved {
  return isObject(v) && ['w', 'h', 'x', 'y', 'size'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
}

export function createFramingMemory(storage: Pick<Storage, 'getItem' | 'setItem'> | null): FramingMemory {
  // The last rect written per camera this visit.
  const written = new Map<string, string>();
  const read = (): Record<string, unknown> => {
    try {
      const raw = storage?.getItem(FRAMING_KEY);
      const all: unknown = raw ? JSON.parse(raw) : null;
      return isObject(all) ? all : {};
    } catch {
      // Unreadable: nothing remembered.
      return {};
    }
  };
  return {
    load(camera, frameW, frameH) {
      const s = read()[camera];
      // Whether it fits the frame is createFraming's check.
      if (isSaved(s) && s.w === frameW && s.h === frameH) {
        return { x: s.x, y: s.y, size: s.size };
      }
      return null;
    },
    save(camera, frameW, frameH, rect) {
      const entry: Saved = { w: frameW, h: frameH, x: rect.x, y: rect.y, size: rect.size };
      const raw = JSON.stringify(entry);
      if (written.get(camera) === raw) {
        return;
      }
      written.set(camera, raw);
      try {
        storage?.setItem(FRAMING_KEY, JSON.stringify({ ...read(), [camera]: entry }));
      } catch {
        // Not remembered; framing still works for this visit.
      }
    },
  };
}
