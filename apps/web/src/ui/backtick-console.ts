// The backtick console: whether it's open, and what it shows when it is. The panel itself is console-panel.ts; this
// adds the boombox column while the local player's boombox plays (boombox spec §3.1).
import type { Boombox } from '../media/boombox';
import type { BoomboxPanelOptions } from './boombox-panel';
import { type ConsolePanelOptions, setConsolePanelBoombox, showConsolePanel } from './console-panel';

export interface BacktickConsoleOptions {
  /** What the panel shows, read each time it opens. */
  panel(): ConsolePanelOptions;
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
        showConsolePanel(ui, null);
        return;
      }
      // The panel is worked with the mouse: let go of mouse-look. A click on the view locks it again.
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
      showConsolePanel(ui, opts.panel());
      setConsolePanelBoombox(ui, boomboxColumn());
    },
    refreshBoombox() {
      setConsolePanelBoombox(ui, boomboxColumn());
    },
  };
}
