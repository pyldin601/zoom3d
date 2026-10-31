// The page around the game: what the URL and the device asked for at load, the elements index.html provides, and the
// browser's storage.

export interface PageFlags {
  pixelPerfect: boolean;
  /** Baked corridor lamps; `?lights=off` shows the old flat look. */
  lights: boolean;
  /** Touch mode (mobile spec §2.0): read once at load and never again, so the frame never flips mid-visit. */
  touch: boolean;
  /** Reduced motion (landing vacuum spec §2.5): the landing picture then stays still. */
  reducedMotion: boolean;
}

export function readPageFlags(search: string, matchesMedia: (query: string) => boolean): PageFlags {
  const params = new URLSearchParams(search);
  return {
    pixelPerfect: params.has('pixelperfect'),
    lights: params.get('lights') !== 'off',
    touch: matchesMedia('(pointer: coarse)'),
    reducedMotion: matchesMedia('(prefers-reduced-motion: reduce)'),
  };
}

export interface PageElements {
  stage: HTMLDivElement;
  game: HTMLCanvasElement;
  hud: HTMLCanvasElement;
  ui: HTMLDivElement;
  /** Where remote media plays, muted, so Chrome feeds it to Web Audio (AGENTS.md). */
  media: HTMLDivElement;
  localMedia: HTMLDivElement;
  gameCtx: CanvasRenderingContext2D;
  hudCtx: CanvasRenderingContext2D;
}

export function findPageElements(doc: Document): PageElements {
  const game = element(doc, 'game', HTMLCanvasElement);
  const hud = element(doc, 'hud', HTMLCanvasElement);
  return {
    stage: element(doc, 'stage', HTMLDivElement),
    game,
    hud,
    ui: element(doc, 'ui', HTMLDivElement),
    media: element(doc, 'media', HTMLDivElement),
    localMedia: element(doc, 'local-media', HTMLDivElement),
    gameCtx: context2d(game),
    hudCtx: context2d(hud),
  };
}

/** Null where storage is blocked (private mode, a sandboxed frame): settings then just aren't remembered. */
export function pageStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function element<T extends HTMLElement>(doc: Document, id: string, type: { new (): T; prototype: T }): T {
  const el = doc.getElementById(id);
  if (!(el instanceof type)) {
    throw new Error(`index.html has no ${type.name} #${id}`);
  }
  return el;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error(`no 2d context for #${canvas.id}`);
  }
  return ctx;
}
