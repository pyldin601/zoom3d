// The backtick console: whether it's open, and what it shows when it is. The panel itself is audio-panel.ts; this
// adds the boombox column while our boombox plays (boombox spec §3.1).
import type { Boombox } from '../media/boombox';
import { type AudioPanelOptions, setAudioPanelBoombox, showAudioPanel } from './audio-panel';
import type { BoomboxPanelOptions } from './boombox-panel';

export interface BacktickConsoleOptions {
  /** What the panel shows, read each time it opens. */
  panel(): AudioPanelOptions;
  boombox(): Boombox | null;
  saveBoomboxVolume(volume: number): void;
}

export interface BacktickConsole {
  toggle(): void;
  /** The boombox started or stopped: its column comes or goes. */
  refreshBoombox(): void;
}

export function createBacktickConsole(ui: HTMLElement, opts: BacktickConsoleOptions): BacktickConsole {
  let open = false;

  const boomboxColumn = (): BoomboxPanelOptions | null => {
    const box = opts.boombox();
    if (!box?.playing()) {
      return null;
    }
    return {
      title: box.title() ?? '',
      volume: box.volume(),
      progress: () => box.progress(),
      onVolume(v) {
        box.setVolume(v);
        opts.saveBoomboxVolume(box.volume());
      },
      onSeek: (seconds) => box.seek(seconds),
      onStop: () => box.toggle(true),
    };
  };

  return {
    toggle() {
      open = !open;
      if (!open) {
        showAudioPanel(ui, null);
        return;
      }
      // The panel is worked with the mouse: let go of mouse-look. A click on the view locks it again.
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
      showAudioPanel(ui, opts.panel());
      setAudioPanelBoombox(ui, boomboxColumn());
    },
    refreshBoombox() {
      setAudioPanelBoombox(ui, boomboxColumn());
    },
  };
}
