// A reloaded tab takes back its place in the room: the resume token is kept in the tab's own storage
// (sessionStorage), saved when the page goes away and removed as soon as it is read, so a tab duplicated while the
// room is open carries no token and joins as someone new instead of taking the place over.
// Storage may be missing or throw (private mode, blocked).

export const RESUME_KEY = 'zoom3d.resume';

interface SavedResume {
  roomId: string;
  token: string;
}

export function saveResume(storage: Pick<Storage, 'setItem'> | null, roomId: string, token: string): void {
  const saved: SavedResume = { roomId, token };
  try {
    storage?.setItem(RESUME_KEY, JSON.stringify(saved));
  } catch {
    // Not kept: the reload joins as someone new.
  }
}

export function takeResume(storage: Pick<Storage, 'getItem' | 'removeItem'> | null, roomId: string): string | null {
  try {
    const raw = storage?.getItem(RESUME_KEY) ?? null;
    storage?.removeItem(RESUME_KEY);
    const saved = raw === null ? null : parseSaved(raw);
    return saved?.roomId === roomId ? saved.token : null;
  } catch {
    return null;
  }
}

function parseSaved(raw: string): SavedResume | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const { roomId, token } = value as Record<string, unknown>;
    return typeof roomId === 'string' && typeof token === 'string' ? { roomId, token } : null;
  } catch {
    return null;
  }
}
