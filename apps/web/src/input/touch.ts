// Touch input (mobile spec §4): a move pad for the left thumb and drag-to-turn anywhere on the view for the right.
// Only touch pointers count; mouse and pen keep their desktop meaning.
import type { MoveInput } from '@zoom3d/shared';
import type { InputDocument } from './keyboard';

/** Fraction of the pad's radius around its centre where a finger moves nothing. */
export const PAD_DEAD_ZONE = 0.25;
/** A horizontal drag across half the view turns this far (radians). */
export const TOUCH_TURN_HALF_SCREEN = Math.PI / 2;

interface Listenable {
  addEventListener(type: string, listener: EventListener): void;
}

export interface PointerTarget extends Listenable {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  setPointerCapture?(pointerId: number): void;
}

export interface TouchSource {
  state(): MoveInput;
  /** Radians of drag turn since the last call. */
  consumeTurn(): number;
  reset(): void;
  /** The pad exists only once the room UI is up; until then only the view turns. */
  attachPad(pad: PointerTarget): void;
}

export interface TouchInputOptions {
  surface: PointerTarget;
  win: Listenable;
  doc: InputDocument;
  /** The view's width in CSS px, read at each move (it changes on rotation). */
  surfaceWidth(): number;
}

/** Sector (0 = right, counter-clockwise in 45° steps) → [forward, strafe]. */
const SECTORS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
];

/**
 * The pad's direction for a finger at (dx, dy) from its centre, screen y down: up is forward. Eight 45° sectors centred
 * on the axes, so diagonals move and strafe at once; nothing inside the dead zone.
 */
export function padDirection(dx: number, dy: number, radius: number): { forward: number; strafe: number } {
  if (!(Math.hypot(dx, dy) > PAD_DEAD_ZONE * radius)) {
    return { forward: 0, strafe: 0 };
  }
  const sector = (Math.round(Math.atan2(-dy, dx) / (Math.PI / 4)) + 8) % 8;
  const [forward, strafe] = SECTORS[sector] as readonly [number, number];
  return { forward, strafe };
}

type Pointer = { pointerId: number; pointerType: string; clientX: number; clientY: number };

export function createTouchInput({ surface, win, doc, surfaceWidth }: TouchInputOptions): TouchSource {
  let padId: number | null = null;
  let padX = 0;
  let padY = 0;
  let padRadius = 1;
  let forward = 0;
  let strafe = 0;
  let turnId: number | null = null;
  let turnX = 0;
  let turn = 0;
  let pad: PointerTarget | null = null;

  const steer = (e: Pointer) => {
    const d = padDirection(e.clientX - padX, e.clientY - padY, padRadius);
    forward = d.forward;
    strafe = d.strafe;
  };
  const reset = () => {
    padId = null;
    turnId = null;
    forward = 0;
    strafe = 0;
    turn = 0;
  };
  const end = (event: Event) => {
    const e = event as unknown as Pointer;
    if (e.pointerId === padId) {
      padId = null;
      forward = 0;
      strafe = 0;
    }
    if (e.pointerId === turnId) {
      turnId = null;
    }
  };

  surface.addEventListener('pointerdown', (event) => {
    const e = event as unknown as Pointer;
    if (e.pointerType !== 'touch' || turnId !== null) {
      return;
    }
    turnId = e.pointerId;
    turnX = e.clientX;
  });
  // Moves and lifts are watched on the window, so a finger that slides off the pad or the view keeps counting.
  win.addEventListener('pointermove', (event) => {
    const e = event as unknown as Pointer;
    if (e.pointerId === padId) {
      steer(e);
    } else if (e.pointerId === turnId) {
      turn += ((e.clientX - turnX) / Math.max(1, surfaceWidth() / 2)) * TOUCH_TURN_HALF_SCREEN;
      turnX = e.clientX;
    }
  });
  win.addEventListener('pointerup', end);
  win.addEventListener('pointercancel', end);
  win.addEventListener('blur', reset);
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') {
      reset();
    }
  });

  return {
    state: () => ({ forward, strafe, turn: 0 }),
    consumeTurn() {
      const t = turn;
      turn = 0;
      return t;
    },
    reset,
    attachPad(target) {
      if (pad === target) {
        return;
      }
      pad = target;
      target.addEventListener('pointerdown', (event) => {
        const e = event as unknown as Pointer;
        if (e.pointerType !== 'touch' || padId !== null || pad !== target) {
          return;
        }
        try {
          target.setPointerCapture?.(e.pointerId);
        } catch {
          // A synthetic pointer (tests) has nothing to capture; the window listeners track it anyway.
        }
        const box = target.getBoundingClientRect();
        padX = box.left + box.width / 2;
        padY = box.top + box.height / 2;
        padRadius = Math.min(box.width, box.height) / 2;
        padId = e.pointerId;
        steer(e);
      });
    },
  };
}
