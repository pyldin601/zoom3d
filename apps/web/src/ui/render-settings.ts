// Renderer options from the console, persisted per browser; storage may be missing or throw (private mode, blocked).
import type { ReflectionMode } from '../renderer/lighting';

export interface RenderSettings {
  reflections: ReflectionMode;
  /** The lighting's ambient part; off, whatever no lamp reaches is black. */
  ambient: boolean;
}

export const RENDER_SETTINGS_KEY = 'zoom3d.render.v1';
export const DEFAULT_RENDER_SETTINGS: RenderSettings = { reflections: 'both', ambient: true };
const REFLECTION_MODES: readonly ReflectionMode[] = ['none', 'walls', 'both'];

/** Each setting is checked on its own, so one that's bad or missing (saved by an older version) falls back alone. */
export function normalizeRenderSettings(raw: unknown): RenderSettings {
  const stored = (raw ?? {}) as { reflections?: unknown; ambient?: unknown };
  return {
    reflections: REFLECTION_MODES.find((m) => m === stored.reflections) ?? DEFAULT_RENDER_SETTINGS.reflections,
    ambient: typeof stored.ambient === 'boolean' ? stored.ambient : DEFAULT_RENDER_SETTINGS.ambient,
  };
}

export function loadRenderSettings(storage: Pick<Storage, 'getItem'> | null): RenderSettings {
  try {
    const raw = storage?.getItem(RENDER_SETTINGS_KEY);
    return normalizeRenderSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_RENDER_SETTINGS;
  }
}

export function saveRenderSettings(storage: Pick<Storage, 'setItem'> | null, s: RenderSettings): void {
  try {
    storage?.setItem(RENDER_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Not persisted; the live settings still apply.
  }
}
