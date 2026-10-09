// Mini player shown while our boombox plays (boombox spec §3.1): track name, a seekable progress
// bar, volume and Stop. All text goes through textContent: the track name is a user's file name.

export interface BoomboxPanelOptions {
  title: string;
  /** 0..1. */
  volume: number;
  progress(): { current: number; duration: number };
  onVolume(v: number): void;
  onSeek(seconds: number): void;
  onStop(): void;
}

export const PROGRESS_MS = 250;
const timers = new WeakMap<HTMLElement, ReturnType<typeof setInterval>>();

/** m:ss, minutes unbounded. */
export function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {}
): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = document.createElement(tag);
  Object.assign(node, props);
  return node;
}

export function showBoomboxPanel(root: HTMLElement, opts: BoomboxPanelOptions | null): void {
  const existing = root.querySelector<HTMLElement>(':scope > .boombox-panel');
  if (existing) {
    clearInterval(timers.get(existing));
    existing.remove();
  }
  if (!opts) {
    return;
  }

  const panel = make('div', { className: 'boombox-panel' });
  panel.append(make('div', { className: 'title', textContent: opts.title }));

  const bar = make('input', { type: 'range', min: '0', max: '0', step: '0.1', value: '0' });
  const time = make('span', { className: 'value' });
  const progressRow = make('label');
  progressRow.append('Progress', bar, time);
  /** While dragging, the bar shows where the drop will seek to, not where the track is. */
  let dragging = false;
  const showTime = (current: number, duration: number) => {
    time.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  };
  const refresh = () => {
    const { current, duration } = opts.progress();
    bar.max = String(duration);
    if (!dragging) {
      bar.value = String(current);
      showTime(current, duration);
    }
  };
  bar.addEventListener('input', () => {
    dragging = true;
    showTime(Number(bar.value), Number(bar.max));
  });
  bar.addEventListener('change', () => {
    dragging = false;
    opts.onSeek(Number(bar.value));
  });

  const volume = make('input', { type: 'range', min: '0', max: '100', step: '1' });
  volume.value = String(Math.round(opts.volume * 100));
  volume.addEventListener('input', () => opts.onVolume(Number(volume.value) / 100));
  const volumeRow = make('label');
  volumeRow.append('Volume', volume);

  const stop = make('button', { type: 'button', textContent: 'Stop' });
  stop.addEventListener('click', () => opts.onStop());

  panel.append(progressRow, volumeRow, stop);
  refresh();
  timers.set(panel, setInterval(refresh, PROGRESS_MS));
  root.append(panel);
}
