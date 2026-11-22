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

/** How fast light goes (D39): 'instant' as always; 'slow' at `lightSpeed`, so motion bends, tints and delays the view. */
export type LightLook = 'instant' | 'slow';

export interface RenderSettings {
  mode: RenderMode;
  portals: PortalLook;
  light: LightLook;
  /** Tiles/s, kept while the look is instant so the slider remembers it. */
  lightSpeed: number;
}

export const RENDER_SETTINGS_KEY = 'zoom3d.render.v1';
/** The slider's range, tiles/s: at the default a scooter at full speed reaches half of c. */
export const LIGHT_SPEED_MIN = 6;
export const LIGHT_SPEED_MAX = 60;
export const DEFAULT_LIGHT_SPEED = 12;
/** Walking, 3 tiles/s, is about 1.4 m/s. */
export const METRES_PER_TILE = 0.47;
export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  mode: 'reflections',
  portals: 'classic',
  light: 'instant',
  lightSpeed: DEFAULT_LIGHT_SPEED,
};
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

export const LIGHT_LOOKS: readonly LightLook[] = ['instant', 'slow'];

export const LIGHT_LOOK_NAMES: Record<LightLook, string> = { instant: 'Instant', slow: 'Slow' };

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
  const stored = (raw ?? {}) as { mode?: unknown; portals?: unknown; light?: unknown; lightSpeed?: unknown };
  return {
    mode: RENDER_MODES.find((m) => m === stored.mode) ?? DEFAULT_RENDER_SETTINGS.mode,
    portals: PORTAL_LOOKS.find((look) => look === stored.portals) ?? DEFAULT_RENDER_SETTINGS.portals,
    light: LIGHT_LOOKS.find((look) => look === stored.light) ?? DEFAULT_RENDER_SETTINGS.light,
    lightSpeed: normalizeLightSpeed(stored.lightSpeed),
  };
}

function normalizeLightSpeed(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_LIGHT_SPEED;
  }
  return Math.min(LIGHT_SPEED_MAX, Math.max(LIGHT_SPEED_MIN, Math.round(raw)));
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
