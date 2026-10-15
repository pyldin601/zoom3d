// Renderer options from the console, persisted per browser; storage may be missing or throw (private mode, blocked).
import type { ReflectionMode } from '../renderer/lighting';

export interface RenderSettings {
  reflections: ReflectionMode;
}

export const RENDER_SETTINGS_KEY = 'zoom3d.render.v1';
export const DEFAULT_RENDER_SETTINGS: RenderSettings = { reflections: 'both' };
const REFLECTION_MODES: readonly ReflectionMode[] = ['none', 'walls', 'both'];

export function normalizeRenderSettings(raw: unknown): RenderSettings {
  const reflections = (raw as { reflections?: unknown } | null)?.reflections;
  return REFLECTION_MODES.find((m) => m === reflections)
    ? { reflections: reflections as ReflectionMode }
    : DEFAULT_RENDER_SETTINGS;
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
