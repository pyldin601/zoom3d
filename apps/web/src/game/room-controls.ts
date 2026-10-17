// The room's controls besides walking: its keys (room-keys.ts) and touch controls (mobile spec §5), turned into the
// room's actions. Whether the map is open lives here, since only these toggle it.
import type { HeldItem } from '@zoom3d/shared';
import type { DrinkKey } from '../input/drink-key';
import { type RoomKey, roomKey } from '../input/room-keys';
import type { TouchSource } from '../input/touch';
import { heldKeyAction } from '../ui/held-store';
import { showTouchControls, type TouchControls } from '../ui/touch-controls';
import { isConnected, type Room } from './room';
import type { You } from './you';

export interface RoomControlsOptions {
  ui: HTMLElement;
  touch: TouchSource;
  you: You;
  drinkKey: DrinkKey;
  room(): Room | null;
  chooseDrink(item: HeldItem | null): void;
  toggleConsole(): void;
}

export interface RoomControls {
  readonly mapShown: boolean;
  /** From Join in touch mode; otherwise they come with the first touch in the room. */
  showTouchControls(): void;
  /** Your drink, your boombox or the map changed. */
  refresh(): void;
}

export function createRoomControls(o: RoomControlsOptions): RoomControls {
  const { you, drinkKey } = o;
  let mapShown = false;
  let touchControls: TouchControls | null = null;
  const inRoom = () => isConnected(o.room());

  const refresh = () => touchControls?.update({ held: you.drink, boombox: you.boombox, map: mapShown });

  const toggleMap = () => {
    mapShown = !mapShown;
    refresh();
  };

  /** B opens the boombox's file picker, or stops the music (boombox spec §3); stopping works while reconnecting. */
  const toggleBoombox = () => o.room()?.boombox.toggle(inRoom());

  const onRoomKey = (key: RoomKey, e: KeyboardEvent) => {
    switch (key.kind) {
      case 'console':
        e.preventDefault();
        o.toggleConsole();
        break;
      case 'map':
        e.preventDefault();
        if (!key.repeat) {
          toggleMap();
        }
        break;
      case 'boombox':
        e.preventDefault();
        toggleBoombox();
        break;
      case 'drink':
        // 1–3 pick a drink, 0 puts it down; the drink in hand's own key sips or cheers it.
        e.preventDefault();
        if (heldKeyAction(key.item, you.drink) === 'pick') {
          o.chooseDrink(key.item);
        } else {
          drinkKey.down(e.timeStamp, key.code);
        }
        break;
      case 'media':
        // The same as pressing the mic button or your own circle (feedback, a camera that can't start, a missing
        // device and all).
        o.ui.querySelector<HTMLButtonElement>(`button[data-control="${key.control}"]`)?.click();
        break;
    }
  };

  const showTouch = () => {
    if (touchControls || !o.room()) {
      return;
    }
    touchControls = showTouchControls(o.ui, {
      held: you.drink,
      boombox: you.boombox,
      map: mapShown,
      onPick(item) {
        if (inRoom()) {
          o.chooseDrink(item);
        }
      },
      onDrinkDown: (t) => {
        if (inRoom()) {
          drinkKey.down(t, 'touch');
        }
      },
      onDrinkUp: (t) => drinkKey.up(t, 'touch'),
      onDrinkCancel: () => drinkKey.cancel('touch'),
      onBoombox: toggleBoombox,
      onMap: () => {
        if (inRoom()) {
          toggleMap();
        }
      },
    });
    o.touch.attachPad(touchControls.pad);
  };

  window.addEventListener('keydown', (e) => {
    // A modifier mid-press means a shortcut, and macOS never reports a key released while Cmd is held: forget the press.
    if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') {
      drinkKey.cancel();
    }
    const key = roomKey(e, { inRoom: inRoom(), hasBoombox: o.room() !== null });
    if (key) {
      onRoomKey(key, e);
    }
  });
  window.addEventListener('keyup', (e) => drinkKey.up(e.timeStamp, e.code));
  // A key released in another window never reports keyup here: forget the press.
  window.addEventListener('blur', () => drinkKey.cancel());
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      showTouch();
    }
  });

  return {
    get mapShown() {
      return mapShown;
    },
    showTouchControls: showTouch,
    refresh,
  };
}
