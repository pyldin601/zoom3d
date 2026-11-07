// The room's controls besides walking: its keys (room-keys.ts) and touch controls (mobile spec §5), turned into the
// room's actions. Whether the map is open lives here, since only these toggle it.
import type { HeldItem } from '@zoom3d/shared';
import type { DrinkKey } from '../input/drink-key';
import { type RoomKey, roomKey } from '../input/room-keys';
import type { TouchSource } from '../input/touch';
import { track } from '../telemetry/analytics';
import { heldKeyAction } from '../ui/held-store';
import { nextRenderMode, type RenderMode } from '../ui/render-settings';
import { el } from '../ui/screens';
import { showTouchControls, type TouchControls } from '../ui/touch-controls';
import type { LocalPlayer } from './local-player';
import { isConnected, type Room } from './room';

export interface RoomControlsOptions {
  ui: HTMLElement;
  touch: TouchSource;
  localPlayer: LocalPlayer;
  drinkKey: DrinkKey;
  room(): Room | null;
  chooseHeld(item: HeldItem | null): void;
  toggleConsole(): void;
  renderMode(): RenderMode;
  setRenderMode(mode: RenderMode): void;
}

export interface RoomControls {
  readonly mapShown: boolean;
  /** From Join in touch mode; otherwise they come with the first touch in the room. */
  showTouchControls(): void;
  /** What the local player holds, their boombox, the map or the lighting changed. */
  refresh(): void;
  /** Whether the ball is within kick reach; the touch controls change only when it flips. */
  setKickInReach(inReach: boolean): void;
  /** Whether a parked scooter is in reach on foot, and whether one is ridden: the hint and the touch button. */
  setScooterState(inReach: boolean, riding: boolean): void;
}

export function createRoomControls(o: RoomControlsOptions): RoomControls {
  const { localPlayer, drinkKey } = o;
  let mapShown = false;
  let touchControls: TouchControls | null = null;
  let kickInReach = false;
  let scooterInReach = false;
  let riding = false;
  /** Shown on the keyboard only: touch mode's CSS hides it, where the scooter button says as much. */
  const rideHint = el('div', { className: 'ride-hint', textContent: 'E: ride' });
  rideHint.hidden = true;
  const inRoom = () => isConnected(o.room());
  const scooterButtonShown = () => scooterInReach || riding;

  const toggleRide = () => {
    const room = o.room();
    if (room && inRoom()) {
      room.ride.toggle(localPlayer.pose);
    }
  };

  const refresh = () =>
    touchControls?.update({
      held: localPlayer.held,
      boombox: localPlayer.boombox,
      map: mapShown,
      lighting: o.renderMode(),
      kick: kickInReach,
      scooter: scooterButtonShown(),
    });

  const toggleMap = () => {
    mapShown = !mapShown;
    refresh();
  };

  /** Tracked once, by the presser: the server's answer reaches everyone. */
  const togglePortals = () => {
    const room = o.room();
    if (room && inRoom()) {
      track({ name: 'portals_toggled', on: !room.session.portals });
      room.session.sendPortals();
    }
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
      case 'held':
        // 1–3 pick a drink, 9 the lighter, 0 empties the hand; a drink in hand's own key sips or cheers it.
        e.preventDefault();
        if (heldKeyAction(key.item, localPlayer.held) === 'pick') {
          o.chooseHeld(key.item);
        } else {
          drinkKey.down(e.timeStamp, key.code);
        }
        break;
      case 'kick':
        e.preventDefault();
        o.room()?.kick();
        break;
      case 'portals':
        e.preventDefault();
        togglePortals();
        break;
      case 'ride':
        e.preventDefault();
        toggleRide();
        break;
      case 'media':
        // The same as pressing the mic button or the self-view circle (feedback, a camera that can't start, a missing
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
      held: localPlayer.held,
      boombox: localPlayer.boombox,
      map: mapShown,
      lighting: o.renderMode(),
      kick: kickInReach,
      scooter: scooterButtonShown(),
      onScooter: toggleRide,
      onPick(item) {
        if (inRoom()) {
          o.chooseHeld(item);
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
      onLighting: () => {
        o.setRenderMode(nextRenderMode(o.renderMode()));
        refresh();
      },
      onKick: () => {
        if (inRoom()) {
          o.room()?.kick();
        }
      },
    });
    o.touch.attachPad(touchControls.pad);
  };

  window.addEventListener('keydown', (e) => {
    // A modifier mid-press means a shortcut, and macOS never reports a key released while Cmd is held: forget the
    // press.
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
    setKickInReach(inReach) {
      if (inReach !== kickInReach) {
        kickInReach = inReach;
        refresh();
      }
    },
    setScooterState(inReach, isRiding) {
      if (inReach === scooterInReach && isRiding === riding) {
        return;
      }
      scooterInReach = inReach;
      riding = isRiding;
      if (!rideHint.isConnected) {
        o.ui.append(rideHint);
      }
      rideHint.hidden = !inReach;
      refresh();
    },
  };
}
