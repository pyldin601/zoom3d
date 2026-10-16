// The backtick panel: the frame rate at the top, the renderer's options under it, and the boombox's controls on the
// right while it plays (boombox spec §3.1). All text goes through textContent.
import { frameRateBand } from '../game/frame-rate';
import type { ReflectionMode } from '../renderer/lighting';
import { type BoomboxPanelOptions, showBoomboxPanel } from './boombox-panel';
import { normalizeRenderSettings, type RenderSettings } from './render-settings';

export interface AudioPanelOptions {
  /** Frames per second, or null before it is measured; refreshed while the panel is open. */
  frameRate: () => number | null;
  /** The renderer's options. */
  render: { settings: RenderSettings; onChange(s: RenderSettings): void };
}

const REFLECTIONS: readonly [ReflectionMode, string][] = [
  ['none', 'None'],
  ['walls', 'Walls'],
  ['both', 'Walls, floor and ceiling'],
];

/** How often the frame rate is redrawn while the panel is open. */
const REFRESH_MS = 200;
const timers = new WeakMap<HTMLElement, ReturnType<typeof setInterval>>();

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {}
): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = document.createElement(tag);
  Object.assign(node, props);
  return node;
}

export function showAudioPanel(root: HTMLElement, opts: AudioPanelOptions | null): void {
  const existing = root.querySelector<HTMLElement>(':scope > .audio-panel');
  if (existing) {
    clearInterval(timers.get(existing));
    const slot = existing.querySelector<HTMLElement>(':scope > .boombox-slot');
    if (slot) {
      showBoomboxPanel(slot, null);
    }
    existing.remove();
  }
  if (!opts) {
    return;
  }

  const panel = make('div', { className: 'audio-panel' });
  // The renderer on the left; the boombox's controls on the right while it plays.
  const renderer = make('div', { className: 'renderer' });
  const slot = make('div', { className: 'boombox-slot' });
  const rate = make('span');
  const refresh = () => {
    const fps = opts.frameRate();
    rate.textContent = fps === null ? '–' : `${fps} fps`;
    rate.className = fps === null ? '' : frameRateBand(fps);
  };
  const frameRateRow = make('div', { className: 'frame-rate' });
  frameRateRow.append('Frame rate ', rate);
  renderer.append(frameRateRow, make('h2', { textContent: 'Renderer' }), reflectionsRow(opts.render));
  refresh();
  timers.set(panel, setInterval(refresh, REFRESH_MS));

  panel.append(renderer, slot);
  root.append(panel);
}

function reflectionsRow(opts: AudioPanelOptions['render']): HTMLElement {
  let current = opts.settings;
  const reflections = make('select');
  for (const [value, text] of REFLECTIONS) {
    reflections.append(make('option', { value, textContent: text }));
  }
  reflections.value = current.reflections;
  reflections.addEventListener('change', () => {
    current = normalizeRenderSettings({ ...current, reflections: reflections.value });
    opts.onChange(current);
  });
  const row = make('label');
  row.append('Reflections', reflections);
  return row;
}

/** Shows (or with null, clears) the boombox controls in the open panel; no-op when it's closed. */
export function setAudioPanelBoombox(root: HTMLElement, opts: BoomboxPanelOptions | null): void {
  const slot = root.querySelector<HTMLElement>(':scope > .audio-panel > .boombox-slot');
  if (slot) {
    showBoomboxPanel(slot, opts);
  }
}
