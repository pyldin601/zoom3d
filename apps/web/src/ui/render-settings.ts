// Renderer options from the console, persisted per browser; storage may be missing or throw (private mode, blocked).
import type { ReflectionMode } from '../renderer/lighting';

/**
 * How the room is drawn: 'flat' unlit, as before lighting (no lamps, shadows or glow); 'shadows' lit, without the
 * lamps' reflections; 'reflections' lit with them (the default); 'reflections-only' those reflections alone, on black.
 */
export type RenderMode = 'flat' | 'shadows' | 'reflections' | 'reflections-only';

/**
 * How portal doorways are seen (D38): 'classic' shows where a walker going in comes out; 'realistic' lets light go only
 * the way walkers go, so a doorway's front looks ordinary and its back shows the room that leads into it.
 */
export type PortalLook = 'classic' | 'realistic';

export interface RenderSettings {
  mode: RenderMode;
  portals: PortalLook;
}

export const RENDER_SETTINGS_KEY = 'zoom3d.render.v1';
export const DEFAULT_RENDER_SETTINGS: RenderSettings = { mode: 'reflections', portals: 'classic' };
/** Every mode, in the order the console lists them. */
export const RENDER_MODES: readonly RenderMode[] = ['flat', 'shadows', 'reflections', 'reflections-only'];

/** What the console calls each mode. A Record, so a new mode can't be added without its name. */
export const RENDER_MODE_NAMES: Record<RenderMode, string> = {
  flat: 'No shadows (classic)',
  shadows: 'Shadows',
  reflections: 'Shadows and reflections',
  'reflections-only': 'Reflections only',
};

/** Every portal look, in the order the console lists them. */
export const PORTAL_LOOKS: readonly PortalLook[] = ['classic', 'realistic'];

export const PORTAL_LOOK_NAMES: Record<PortalLook, string> = { classic: 'Classic', realistic: 'Realistic' };

/** The mode after `mode` in the console's order, wrapping from the last back to the first: the tray's one button. */
export function nextRenderMode(mode: RenderMode): RenderMode {
  const following = RENDER_MODES.at((RENDER_MODES.indexOf(mode) + 1) % RENDER_MODES.length);
  return following ?? DEFAULT_RENDER_SETTINGS.mode;
}

/** What the lit renderer reflects in `mode`; null when the room is drawn unlit. */
export function litReflections(mode: RenderMode): ReflectionMode | null {
  switch (mode) {
    case 'flat':
      return null;
    case 'shadows':
      return 'none';
    case 'reflections':
      return 'both';
    case 'reflections-only':
      return 'only';
  }
}

/** Each setting is checked on its own, so one that's bad or missing (saved by an older version) falls back alone. */
export function normalizeRenderSettings(raw: unknown): RenderSettings {
  const stored = (raw ?? {}) as { mode?: unknown; portals?: unknown };
  return {
    mode: RENDER_MODES.find((m) => m === stored.mode) ?? DEFAULT_RENDER_SETTINGS.mode,
    portals: PORTAL_LOOKS.find((look) => look === stored.portals) ?? DEFAULT_RENDER_SETTINGS.portals,
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
