// The backtick panel: the frame rate and which of our face sizes others receive at the top, the renderer's lighting mode
// under them, and the boombox's controls on the right while it plays (boombox spec §3.1). All text goes through
// textContent.
import { frameRateBand } from '../game/frame-rate';
import type { FacesSent } from '../media/transport';
import { type BoomboxPanelOptions, showBoomboxPanel } from './boombox-panel';
import { normalizeRenderSettings, type RenderMode, type RenderSettings } from './render-settings';

export interface AudioPanelOptions {
  /** Frames per second, or null before it is measured; refreshed while the panel is open. */
  frameRate: () => number | null;
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

/** The face sizes, biggest first: one dot each, the biggest dot for the biggest face. */
const FACE_SIZES: readonly (keyof FacesSent)[] = [256, 128, 64];

/** How often the frame rate and the face dots are redrawn while the panel is open. */
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
  const dots = FACE_SIZES.map(() => make('span'));
  const refresh = () => {
    const fps = opts.frameRate();
    rate.textContent = fps === null ? '–' : `${fps} fps`;
    rate.className = fps === null ? '' : frameRateBand(fps);
    const sent = opts.facesSent();
    for (const [i, size] of FACE_SIZES.entries()) {
      dots.at(i)?.classList.toggle('on', sent[size]);
    }
  };
  const frameRateRow = make('div', { className: 'frame-rate' });
  frameRateRow.append('Frame rate ', rate);
  const dotBox = make('span', { className: 'dots' });
  dotBox.append(...dots);
  const faceRow = make('div', { className: 'face-sent' });
  faceRow.append('Face sent', dotBox);
  renderer.append(frameRateRow, faceRow, make('h2', { textContent: 'Renderer' }), lightingRow(opts.render));
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
