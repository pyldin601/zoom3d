// Keyboard + pointer-lock mouse input, merged with touch when present. Held keys are released on blur / tab hide.
import type { MoveInput } from '@zoom3d/shared';
import type { TouchSource } from './touch';

export const MOUSE_TURN_PER_PX = 0.0025; // radians

interface Listenable {
  addEventListener(type: string, listener: EventListener): void;
}

export interface InputDocument extends Listenable {
  visibilityState: DocumentVisibilityState;
  pointerLockElement: Element | null;
}

type Action = 'forward' | 'back' | 'left' | 'right' | 'turnLeft' | 'turnRight';

const BINDINGS: Record<string, Action> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  KeyD: 'right',
  ArrowLeft: 'turnLeft',
  KeyQ: 'turnLeft',
  ArrowRight: 'turnRight',
  KeyE: 'turnRight',
};

export interface Input {
  state(): MoveInput;
  /** Radians of mouse turn since the last call. */
  consumeMouseTurn(): number;
  reset(): void;
}

/** Keys typed into text fields belong to the field, not to movement. */
export function isTextEntry(target: EventTarget | null): boolean {
  const t = target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!t && (t.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName ?? ''));
}

export function createInput(win: Listenable, doc: InputDocument, touch?: TouchSource): Input {
  const held = new Set<Action>();
  let mouseTurn = 0;
  const axis = (pos: Action, neg: Action) => (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const reset = () => {
    held.clear();
    mouseTurn = 0;
  };

  win.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    // Leave browser/OS shortcuts alone (Cmd+S, Ctrl+D, ...).
    if (e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) {
      return;
    }
    const action = BINDINGS[e.code];
    if (!action) {
      return;
    }
    e.preventDefault();
    held.add(action);
  });
  win.addEventListener('keyup', (event) => {
    const code = (event as KeyboardEvent).code;
    // macOS drops keyup for keys released while Cmd is held; drop everything when Cmd goes up.
    if (code === 'MetaLeft' || code === 'MetaRight') {
      held.clear();
    }
    const action = BINDINGS[code];
    if (action) {
      held.delete(action);
    }
  });
  win.addEventListener('blur', reset);
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') {
      reset();
    }
  });
  doc.addEventListener('mousemove', (event) => {
    if (doc.pointerLockElement) {
      mouseTurn += (event as MouseEvent).movementX * MOUSE_TURN_PER_PX;
    }
  });

  return {
    state() {
      const t = touch?.state();
      return {
        forward: clamp(axis('forward', 'back') + (t?.forward ?? 0)),
        strafe: clamp(axis('right', 'left') + (t?.strafe ?? 0)),
        turn: clamp(axis('turnRight', 'turnLeft') + (t?.turn ?? 0)),
      };
    },
    consumeMouseTurn() {
      const turn = mouseTurn + (touch?.consumeTurn() ?? 0);
      mouseTurn = 0;
      return turn;
    },
    reset() {
      reset();
      touch?.reset();
    },
  };
}
