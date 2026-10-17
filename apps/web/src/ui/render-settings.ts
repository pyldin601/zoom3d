// Renderer options from the console, persisted per browser; storage may be missing or throw (private mode, blocked).
import type { ReflectionMode } from '../renderer/lighting';

/**
 * How the room is drawn: 'flat' unlit, as before lighting (no lamps, shadows or glow); 'shadows' lit, without the
 * lamps' reflections; 'reflections' lit with them (the default); 'reflections-only' those reflections alone, on black;
 * 'traced' lit by rays once they are baked, and the lit room with its reflections until then.
 */
export type RenderMode = 'flat' | 'shadows' | 'reflections' | 'reflections-only' | 'traced';

export interface RenderSettings {
  mode: RenderMode;
}

export const RENDER_SETTINGS_KEY = 'zoom3d.render.v1';
export const DEFAULT_RENDER_SETTINGS: RenderSettings = { mode: 'reflections' };
/** Every mode, in the order the console lists them. */
export const RENDER_MODES: readonly RenderMode[] = ['flat', 'shadows', 'reflections', 'reflections-only', 'traced'];

/** What the console calls each mode. A Record, so a new mode can't be added without its name. */
export const RENDER_MODE_NAMES: Record<RenderMode, string> = {
  flat: 'No shadows (classic)',
  shadows: 'Shadows',
  reflections: 'Shadows and reflections',
  'reflections-only': 'Reflections only',
  traced: 'Ray traced',
};

/** The mode after `mode` in the console's order, wrapping from the last back to the first: the tray's one button. */
export function nextRenderMode(mode: RenderMode): RenderMode {
  const following = RENDER_MODES.at((RENDER_MODES.indexOf(mode) + 1) % RENDER_MODES.length);
  return following ?? DEFAULT_RENDER_SETTINGS.mode;
}

/** Whether `mode` draws the room with rays instead of the lit renderer's baked lighting. */
export function tracesRays(mode: RenderMode): boolean {
  return mode === 'traced';
}

/**
 * What the lit renderer reflects in `mode`; null when the room is drawn unlit. For 'traced' it is what draws while
 * the bake runs.
 */
export function litReflections(mode: RenderMode): ReflectionMode | null {
  switch (mode) {
    case 'flat':
      return null;
    case 'shadows':
      return 'none';
    case 'reflections':
    case 'traced':
      return 'both';
    case 'reflections-only':
      return 'only';
  }
}

/** Each setting is checked on its own, so one that's bad or missing (saved by an older version) falls back alone. */
export function normalizeRenderSettings(raw: unknown): RenderSettings {
  const stored = (raw ?? {}) as { mode?: unknown };
  return {
    mode: RENDER_MODES.find((m) => m === stored.mode) ?? DEFAULT_RENDER_SETTINGS.mode,
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
