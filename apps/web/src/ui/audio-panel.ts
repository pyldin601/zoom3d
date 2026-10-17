// The backtick panel: the frame rate, the render time and which of our face sizes others receive at the top, the renderer's lighting mode
// under them, and the boombox's controls on the right while it plays (boombox spec §3.1). All text goes through
// textContent.
import { frameRateBand, type RenderLoad, renderLoadBand } from '../game/frame-rate';
import type { FacesSent } from '../media/transport';
import { type BoomboxPanelOptions, showBoomboxPanel } from './boombox-panel';
import { normalizeRenderSettings, type RenderMode, type RenderSettings } from './render-settings';
import { el } from './screens';

export interface AudioPanelOptions {
  /** Frames per second, or null before it is measured; refreshed while the panel is open. */
  frameRate: () => number | null;
  /** The time drawing a frame takes, also as a share of a screen frame, or null before it is measured. */
  renderLoad: () => RenderLoad | null;
  /** Which of our face sizes others receive (6c); refreshed while the panel is open. */
  facesSent: () => FacesSent;
  /** The renderer's options. */
  render: { settings: RenderSettings; onChange(s: RenderSettings): void };
}

const MODES: readonly [RenderMode, string][] = [
  ['flat', 'No shadows (classic)'],
  ['shadows', 'Shadows'],
  ['reflections', 'Shadows and reflections'],
  ['reflections-only', 'Reflections only'],
];

/** The face sizes, biggest first: a dot and the size's number each. */
const FACE_SIZES: readonly (keyof FacesSent)[] = [256, 128, 64];

/** How often the frame rate, render time and face dots are redrawn while the panel is open. */
const REFRESH_MS = 200;
const timers = new WeakMap<HTMLElement, ReturnType<typeof setInterval>>();

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

  const panel = el('div', { className: 'audio-panel' });
  // The renderer on the left; the boombox's controls on the right while it plays.
  const renderer = el('div', { className: 'renderer' });
  const slot = el('div', { className: 'boombox-slot' });
  const rate = el('span');
  const renderTime = el('span');
  const dots = FACE_SIZES.map((size) => el('span', { textContent: String(size) }));
  const refresh = () => {
    const fps = opts.frameRate();
    rate.textContent = fps === null ? '–' : `${fps} fps`;
    rate.className = fps === null ? '' : frameRateBand(fps);
    const load = opts.renderLoad();
    renderTime.textContent = load === null ? '–' : `${Math.round(load.share * 100)}% · ${load.ms.toFixed(1)} ms`;
    renderTime.className = load === null ? '' : renderLoadBand(load.share);
    const sent = opts.facesSent();
    for (const [i, size] of FACE_SIZES.entries()) {
      dots.at(i)?.classList.toggle('on', sent[size]);
    }
  };
  const frameRateRow = el('div', { className: 'frame-rate' });
  frameRateRow.append('Frame rate ', rate);
  const renderLoadRow = el('div', { className: 'render-load' });
  renderLoadRow.append('Render time', renderTime);
  const dotBox = el('span', { className: 'dots' });
  dotBox.append(...dots);
  const faceRow = el('div', { className: 'face-sent' });
  faceRow.append('Face sent', dotBox);
  renderer.append(
    frameRateRow,
    renderLoadRow,
    faceRow,
    el('h2', { textContent: 'Renderer' }),
    lightingRow(opts.render)
  );
  refresh();
  timers.set(panel, setInterval(refresh, REFRESH_MS));

  panel.append(renderer, slot);
  root.append(panel);
}

function lightingRow(opts: AudioPanelOptions['render']): HTMLElement {
  let current = opts.settings;
  const mode = el('select');
  for (const [value, text] of MODES) {
    mode.append(el('option', { value, textContent: text }));
  }
  mode.value = current.mode;
  mode.addEventListener('change', () => {
    current = normalizeRenderSettings({ ...current, mode: mode.value });
    opts.onChange(current);
  });
  const row = el('label');
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
