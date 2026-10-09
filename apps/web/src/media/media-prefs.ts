// Camera and mic choices, remembered per browser (lobby spec §3.5); storage may be missing or throw.
export const MEDIA_KEY = 'zoom3d.media';

export interface MediaPrefs {
  cam: boolean;
  mic: boolean;
  camId: string | null;
  micId: string | null;
}

export const DEFAULT_MEDIA_PREFS: MediaPrefs = { cam: true, mic: true, camId: null, micId: null };

const isId = (v: unknown): v is string | null => v === null || typeof v === 'string';

function isMediaPrefs(v: unknown): v is MediaPrefs {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return false;
  }
  const p = v as Record<string, unknown>;
  return typeof p.cam === 'boolean' && typeof p.mic === 'boolean' && isId(p.camId) && isId(p.micId);
}

export function loadMediaPrefs(storage: Pick<Storage, 'getItem'> | null): MediaPrefs {
  try {
    const raw = storage?.getItem(MEDIA_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (isMediaPrefs(parsed)) {
      return { cam: parsed.cam, mic: parsed.mic, camId: parsed.camId, micId: parsed.micId };
    }
  } catch {
    // Unreadable: fall through to the defaults.
  }
  return { ...DEFAULT_MEDIA_PREFS };
}

export function saveMediaPrefs(storage: Pick<Storage, 'setItem'> | null, prefs: MediaPrefs): void {
  try {
    storage?.setItem(MEDIA_KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered; the choice still applies for this visit.
  }
}
