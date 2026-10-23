// The room's touch controls (mobile spec §5): the move pad bottom-left, and bottom-right above the self-view a kick
// button while the ball is in reach (ball spec §7), a drink button (tap to sip, hold to cheers) and a ⋯ button whose
// tray holds the occasional actions. DOM only: main.ts
// wires the handlers, and input/touch.ts reads the pad.
import type { HeldItem } from '@zoom3d/shared';
import { touchIcon } from './icons';
import { RENDER_MODE_NAMES, type RenderMode } from './render-settings';
import { el } from './screens';

export interface TouchControlsState {
  held: HeldItem | null;
  boombox: boolean;
  map: boolean;
  lighting: RenderMode;
  /** The ball is within kick reach: the kick button shows. */
  kick: boolean;
}

export interface TouchControlsOptions extends TouchControlsState {
  onPick(item: HeldItem | null): void;
  /** The drink button went down / came up, on the event clock (`timeStamp`), like the number keys. */
  onDrinkDown(t: number): void;
  onDrinkUp(t: number): void;
  onDrinkCancel(): void;
  onBoombox(): void;
  onMap(): void;
  /** Steps to the next lighting mode; the new mode comes back through `update`. */
  onLighting(): void;
  onKick(): void;
}

export interface TouchControls {
  /** The move pad, for input/touch.ts. */
  pad: HTMLElement;
  update(s: TouchControlsState): void;
  remove(): void;
}

const DRINKS: readonly { item: HeldItem | null; label: string }[] = [
  { item: 'beer', label: 'Beer' },
  { item: 'coffee', label: 'Coffee' },
  { item: 'wine', label: 'Wine' },
  { item: null, label: 'Nothing' },
];

function iconButton(className: string, label: string, icon: SVGSVGElement, text?: string): HTMLButtonElement {
  const button = el('button', { type: 'button', className });
  button.setAttribute('aria-label', label);
  button.append(icon);
  if (text) {
    button.append(el('span', { textContent: text }));
  }
  return button;
}

export function showTouchControls(root: HTMLElement, opts: TouchControlsOptions): TouchControls {
  const pad = createMovePad();
  const kick = iconButton('kick', 'Kick the ball', touchIcon('ball'));
  // On the press, not the click: a kick should land the moment the thumb does.
  kick.addEventListener('pointerdown', () => opts.onKick());
  const drink = createDrinkButton(opts);
  const tray = createTray(opts);
  const buttons = el('div', { className: 'touch-buttons' }, kick, drink.button, tray.more);
  root.append(pad, tray.tray, buttons);

  const update = (s: TouchControlsState) => {
    kick.hidden = !s.kick;
    drink.update(s.held);
    tray.update(s);
  };
  update(opts);

  return {
    pad,
    update,
    remove() {
      tray.stopClosingOnOutsidePress();
      pad.remove();
      tray.tray.remove();
      buttons.remove();
    },
  };
}

function createMovePad(): HTMLElement {
  const pad = el('div', { className: 'touch-pad' });
  pad.setAttribute('role', 'img');
  pad.setAttribute('aria-label', 'Move');
  for (const [cls, glyph] of [
    ['up', '▲'],
    ['left', '◀'],
    ['right', '▶'],
    ['down', '▼'],
  ] as const) {
    const arrow = el('span', { className: cls, textContent: glyph });
    arrow.setAttribute('aria-hidden', 'true');
    pad.append(arrow);
  }
  const light = (on: boolean) => (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      pad.classList.toggle('active', on);
    }
  };
  pad.addEventListener('pointerdown', light(true));
  pad.addEventListener('pointerup', light(false));
  pad.addEventListener('pointercancel', light(false));
  return pad;
}

/** The drink in hand: a tap sips, a long press cheers. Hidden with nothing in hand. */
function createDrinkButton(opts: TouchControlsOptions) {
  const button = iconButton('drink', '', touchIcon('beer'));
  let pressed = false;
  button.addEventListener('pointerdown', (e) => {
    pressed = true;
    opts.onDrinkDown(e.timeStamp);
  });
  button.addEventListener('pointerup', (e) => {
    if (pressed) {
      pressed = false;
      opts.onDrinkUp(e.timeStamp);
    }
  });
  for (const type of ['pointercancel', 'pointerleave'] as const) {
    button.addEventListener(type, () => {
      if (pressed) {
        pressed = false;
        opts.onDrinkCancel();
      }
    });
  }
  // A long press is a cheers, not the browser's context menu.
  button.addEventListener('contextmenu', (e) => e.preventDefault());
  return {
    button,
    update(held: HeldItem | null) {
      button.hidden = held === null;
      if (held) {
        button.setAttribute('aria-label', `Sip ${held} (hold to cheers)`);
        button.replaceChildren(touchIcon(held));
      }
    },
  };
}

/** The ⋯ button and the tray it opens: the drinks, the boombox, the map and the lighting. */
function createTray(opts: TouchControlsOptions) {
  const tray = el('div', { className: 'tray', hidden: true });
  const more = iconButton('more', 'More', touchIcon('more'));
  more.setAttribute('aria-expanded', 'false');
  const setOpen = (open: boolean) => {
    tray.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  };
  more.addEventListener('click', () => setOpen(tray.hidden !== false));
  /** Each choice closes the tray, then acts. */
  const choice = (button: HTMLButtonElement, act: () => void) => {
    button.addEventListener('click', () => {
      setOpen(false);
      act();
    });
    return button;
  };

  const drinkButtons = DRINKS.map(({ item, label }) => ({
    item,
    button: choice(iconButton('', label, touchIcon(item ?? 'none'), label), () => opts.onPick(item)),
  }));
  const boomboxLabel = el('span', { textContent: 'Boombox' });
  const boombox = choice(iconButton('', 'Boombox', touchIcon('boombox')), opts.onBoombox);
  boombox.append(boomboxLabel);
  boombox.dataset.action = 'boombox';
  const map = choice(iconButton('', 'Map', touchIcon('map'), 'Map'), opts.onMap);
  map.dataset.action = 'map';
  // Not a choice: stepping through the modes takes several taps, so the tray stays open.
  const lightingLabel = el('span');
  const lighting = iconButton('', 'Lighting', touchIcon('lighting'));
  lighting.append(lightingLabel);
  lighting.dataset.action = 'lighting';
  lighting.addEventListener('click', opts.onLighting);
  tray.append(...drinkButtons.map((d) => d.button), boombox, map, lighting);

  // A tap anywhere but the tray or ⋯ closes it.
  const outside = (e: Event) => {
    if (!tray.hidden && !tray.contains(e.target as Node) && !more.contains(e.target as Node)) {
      setOpen(false);
    }
  };
  document.addEventListener('pointerdown', outside);

  return {
    tray,
    more,
    update(s: TouchControlsState) {
      for (const { item, button } of drinkButtons) {
        button.setAttribute('aria-pressed', String(item === s.held));
      }
      const music = s.boombox ? 'Stop music' : 'Boombox';
      boombox.setAttribute('aria-label', music);
      boomboxLabel.textContent = music;
      map.setAttribute('aria-pressed', String(s.map));
      lightingLabel.textContent = RENDER_MODE_NAMES[s.lighting];
      lighting.setAttribute('aria-label', `Lighting: ${RENDER_MODE_NAMES[s.lighting]}`);
    },
    stopClosingOnOutsidePress: () => document.removeEventListener('pointerdown', outside),
  };
}
