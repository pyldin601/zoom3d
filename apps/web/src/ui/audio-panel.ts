// Live tuning panel for spatial audio (spec §9.3). All text goes through textContent.
import { type AudioSettings, DEFAULT_AUDIO_SETTINGS, normalizeAudioSettings } from '@zoom3d/shared';

export interface AudioPanelOptions {
  settings: AudioSettings;
  onChange(s: AudioSettings): void;
  levels?: () => { name: string; speaking: number }[];
}

type NumericKey = 'ref' | 'max' | 'reverb' | 'muffleHz' | 'occludedGain';

const SLIDERS: { key: NumericKey; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: 'ref', label: 'Full volume within', min: 0.5, max: 5, step: 0.1, unit: ' tiles' },
  { key: 'max', label: 'Silent beyond', min: 4, max: 30, step: 0.5, unit: ' tiles' },
  { key: 'reverb', label: 'Reverb', min: 0, max: 2, step: 0.05, unit: '' },
  { key: 'muffleHz', label: 'Wall muffle cutoff', min: 200, max: 4000, step: 50, unit: ' Hz' },
  { key: 'occludedGain', label: 'Wall attenuation', min: 0, max: 1, step: 0.05, unit: '' },
];

const LEVELS_MS = 200;
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
    existing.remove();
  }
  if (!opts) {
    return;
  }

  let current = opts.settings;
  const panel = make('div', { className: 'audio-panel' });
  const inputs = new Map<NumericKey, { input: HTMLInputElement; value: HTMLSpanElement }>();
  const output = make('select');
  const commit = (next: unknown) => {
    current = normalizeAudioSettings(next);
    render();
    opts.onChange(current);
  };
  const render = () => {
    for (const { key, unit } of SLIDERS) {
      const row = inputs.get(key);
      if (!row) {
        continue;
      }
      row.input.value = String(current[key]);
      row.value.textContent = `${current[key]}${unit}`;
    }
    output.value = current.panning;
  };

  panel.append(make('h2', { textContent: 'Audio tuning' }));
  for (const { key, label, min, max, step } of SLIDERS) {
    const input = make('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    const value = make('span', { className: 'value' });
    input.addEventListener('input', () => commit({ ...current, [key]: Number(input.value) }));
    const row = make('label');
    row.append(label, input, value);
    panel.append(row);
    inputs.set(key, { input, value });
  }
  for (const [value, text] of [
    ['HRTF', 'Headphones (HRTF)'],
    ['equalpower', 'Speakers'],
  ] as const) {
    output.append(make('option', { value, textContent: text }));
  }
  output.addEventListener('change', () => commit({ ...current, panning: output.value }));
  const outputRow = make('label');
  outputRow.append('Output', output);
  panel.append(outputRow);

  const reset = make('button', { type: 'button', textContent: 'Reset' });
  reset.addEventListener('click', () => commit(DEFAULT_AUDIO_SETTINGS));
  panel.append(reset);

  if (opts.levels) {
    const list = make('ul', { className: 'levels' });
    const levels = opts.levels;
    const draw = () => {
      list.replaceChildren(
        ...levels().map(({ name, speaking }) => {
          const bar = make('span', { className: 'bar' });
          bar.style.width = `${Math.round(speaking * 100)}%`;
          const item = make('li');
          item.append(make('span', { textContent: name }), bar);
          return item;
        })
      );
    };
    draw();
    timers.set(panel, setInterval(draw, LEVELS_MS));
    panel.append(list);
  }

  render();
  root.append(panel);
}
