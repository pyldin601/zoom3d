// The backtick panel: the frame rate at the top, the renderer's lighting mode under it, and the boombox's controls on the
// right while it plays (boombox spec §3.1). All text goes through textContent.
import { frameRateBand } from '../game/frame-rate';
import { type BoomboxPanelOptions, showBoomboxPanel } from './boombox-panel';
import { normalizeRenderSettings, type RenderMode, type RenderSettings } from './render-settings';

export interface AudioPanelOptions {
  /** Frames per second, or null before it is measured; refreshed while the panel is open. */
  frameRate: () => number | null;
  /** The renderer's options. */
  render: { settings: RenderSettings; onChange(s: RenderSettings): void };
}

const MODES: readonly [RenderMode, string][] = [
  ['flat', 'No shadows (classic)'],
  ['shadows', 'Shadows'],
  ['reflections', 'Shadows and reflections'],
  ['reflections-only', 'Reflections only'],
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
  renderer.append(frameRateRow, make('h2', { textContent: 'Renderer' }), lightingRow(opts.render));
  refresh();
  timers.set(panel, setInterval(refresh, REFRESH_MS));

  panel.append(renderer, slot);
  root.append(panel);
}

function lightingRow(opts: AudioPanelOptions['render']): HTMLElement {
  let current = opts.settings;
  const mode = make('select');
  for (const [value, text] of MODES) {
    mode.append(make('option', { value, textContent: text }));
  }
  mode.value = current.mode;
  mode.addEventListener('change', () => {
    current = normalizeRenderSettings({ ...current, mode: mode.value });
    opts.onChange(current);
  });
  const row = make('label');
  row.append('Lighting', mode);
  return row;
}

/** Shows (or with null, clears) the boombox controls in the open panel; no-op when it's closed. */
export function setAudioPanelBoombox(root: HTMLElement, opts: BoomboxPanelOptions | null): void {
  const slot = root.querySelector<HTMLElement>(':scope > .audio-panel > .boombox-slot');
  if (slot) {
    showBoomboxPanel(slot, opts);
  }
}
