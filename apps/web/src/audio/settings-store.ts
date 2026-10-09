// Audio tuning persisted per browser; storage may be missing or throw (private mode, blocked).
import { type AudioSettings, normalizeAudioSettings } from '@zoom3d/shared';

export const AUDIO_SETTINGS_KEY = 'zoom3d.audio.v2';

export function loadAudioSettings(storage: Pick<Storage, 'getItem'> | null): AudioSettings {
  try {
    const raw = storage?.getItem(AUDIO_SETTINGS_KEY);
    return normalizeAudioSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeAudioSettings(null);
  }
}

export function saveAudioSettings(storage: Pick<Storage, 'setItem'> | null, s: AudioSettings): void {
  try {
    storage?.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Not persisted; the live settings still apply.
  }
}
