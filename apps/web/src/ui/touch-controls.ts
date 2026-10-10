// The room's touch controls (mobile spec §5): the move pad bottom-left, and bottom-right above the self-view a drink
// button (tap to sip, hold to cheers) and a ⋯ button whose tray holds the occasional actions. DOM only: main.ts
// wires the handlers, and input/touch.ts reads the pad.
import type { HeldItem } from '@zoom3d/shared';
import { touchIcon } from './icons';
import { el } from './screens';

export interface TouchControlsState {
  held: HeldItem | null;
  boombox: boolean;
  map: boolean;
}

export interface TouchControlsOptions extends TouchControlsState {
  onPick(item: HeldItem | null): void;
  /** The drink button went down / came up, on the event clock (`timeStamp`), like the number keys. */
  onDrinkDown(t: number): void;
  onDrinkUp(t: number): void;
  onDrinkCancel(): void;
  onBoombox(): void;
  onMap(): void;
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

  const drink = iconButton('drink', '', touchIcon('beer'));
  let pressed = false;
  drink.addEventListener('pointerdown', (e) => {
    pressed = true;
    opts.onDrinkDown(e.timeStamp);
  });
  drink.addEventListener('pointerup', (e) => {
    if (pressed) {
      pressed = false;
      opts.onDrinkUp(e.timeStamp);
    }
  });
  for (const type of ['pointercancel', 'pointerleave'] as const) {
    drink.addEventListener(type, () => {
      if (pressed) {
        pressed = false;
        opts.onDrinkCancel();
      }
    });
  }
  // A long press is a cheers, not the browser's context menu.
  drink.addEventListener('contextmenu', (e) => e.preventDefault());

  const tray = el('div', { className: 'tray', hidden: true });
  const more = iconButton('more', 'More', touchIcon('more'));
  more.setAttribute('aria-expanded', 'false');
  const setOpen = (open: boolean) => {
    tray.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  };
  more.addEventListener('click', () => setOpen(tray.hidden !== false));

  const drinkButtons = DRINKS.map(({ item, label }) => {
    const button = iconButton('', label, touchIcon(item ?? 'none'), label);
    button.addEventListener('click', () => {
      setOpen(false);
      opts.onPick(item);
    });
    return { item, button };
  });
  const boombox = iconButton('', 'Boombox', touchIcon('boombox'), 'Boombox');
  boombox.dataset.action = 'boombox';
  boombox.addEventListener('click', () => {
    setOpen(false);
    opts.onBoombox();
  });
  const map = iconButton('', 'Map', touchIcon('map'), 'Map');
  map.dataset.action = 'map';
  map.addEventListener('click', () => {
    setOpen(false);
    opts.onMap();
  });
  tray.append(...drinkButtons.map((d) => d.button), boombox, map);

  // A tap anywhere but the tray or ⋯ closes it.
  const outside = (e: Event) => {
    if (!tray.hidden && !tray.contains(e.target as Node) && !more.contains(e.target as Node)) {
      setOpen(false);
    }
  };
  document.addEventListener('pointerdown', outside);

  const buttons = el('div', { className: 'touch-buttons' }, drink, more);
  root.append(pad, tray, buttons);

  const update = (s: TouchControlsState) => {
    drink.hidden = s.held === null;
    if (s.held) {
      drink.setAttribute('aria-label', `Sip ${s.held} (hold to cheers)`);
      drink.replaceChildren(touchIcon(s.held));
    }
    for (const { item, button } of drinkButtons) {
      button.setAttribute('aria-pressed', String(item === s.held));
    }
    const music = s.boombox ? 'Stop music' : 'Boombox';
    boombox.setAttribute('aria-label', music);
    (boombox.querySelector('span') as HTMLSpanElement).textContent = music;
    map.setAttribute('aria-pressed', String(s.map));
  };
  update(opts);

  return {
    pad,
    update,
    remove() {
      document.removeEventListener('pointerdown', outside);
      pad.remove();
      tray.remove();
      buttons.remove();
    },
  };
}
