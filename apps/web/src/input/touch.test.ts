import { describe, expect, test } from 'vitest';
import { createTouchInput, PAD_DEAD_ZONE, padDirection } from './touch';

class FakeTarget {
  listeners = new Map<string, EventListener[]>();
  visibilityState: DocumentVisibilityState = 'visible';
  pointerLockElement: Element | null = null;
  captured: number[] = [];
  addEventListener(type: string, fn: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, event: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event as Event);
    }
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }
  setPointerCapture(id: number) {
    this.captured.push(id);
  }
}

const touch = (pointerId: number, clientX: number, clientY: number, pointerType = 'touch') => ({
  pointerId,
  pointerType,
  clientX,
  clientY,
});

function setup({ attach = true } = {}) {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const pad = new FakeTarget();
  const surface = new FakeTarget();
  const input = createTouchInput({ surface, win, doc, surfaceWidth: () => 400 });
  if (attach) {
    input.attachPad(pad);
  }
  return { win, doc, pad, surface, input };
}

describe('padDirection', () => {
  test.each([
    [0, -40, 1, 0],
    [40, 0, 0, 1],
    [0, 40, -1, 0],
    [-40, 0, 0, -1],
    [30, -30, 1, 1],
    [-30, -30, 1, -1],
    [30, 30, -1, 1],
    [-30, 30, -1, -1],
  ])('padDirection(%i, %i) → forward %i strafe %i', (dx, dy, forward, strafe) => {
    expect(padDirection(dx, dy, 50)).toEqual({ forward, strafe });
  });

  test('inside the dead zone nothing moves', () => {
    expect(padDirection(5, -5, 50)).toEqual({ forward: 0, strafe: 0 });
    expect(padDirection(0, -(PAD_DEAD_ZONE * 50 + 1), 50)).toEqual({ forward: 1, strafe: 0 });
  });

  test('sectors are 45° wide: 20° off north is still straight forward', () => {
    const a = (20 * Math.PI) / 180;
    expect(padDirection(Math.sin(a) * 40, -Math.cos(a) * 40, 50)).toEqual({ forward: 1, strafe: 0 });
  });
});

describe('createTouchInput', () => {
  test('a finger on the pad moves in its direction from the pad centre', () => {
    const { pad, input } = setup();
    pad.dispatch('pointerdown', touch(1, 50, 10));
    expect(input.state()).toEqual({ forward: 1, strafe: 0, turn: 0 });
  });

  test('sliding across the pad changes direction without lifting', () => {
    const { pad, win, input } = setup();
    pad.dispatch('pointerdown', touch(1, 50, 10));
    win.dispatch('pointermove', touch(1, 90, 50));
    expect(input.state()).toEqual({ forward: 0, strafe: 1, turn: 0 });
  });

  test('moves keep tracking outside the pad', () => {
    const { pad, win, input } = setup();
    pad.dispatch('pointerdown', touch(1, 50, 10));
    win.dispatch('pointermove', touch(1, 50, -200));
    expect(input.state().forward).toBe(1);
  });

  test('lifting the finger stops movement', () => {
    const { pad, win, input } = setup();
    pad.dispatch('pointerdown', touch(1, 50, 10));
    win.dispatch('pointerup', touch(1, 50, 10));
    expect(input.state()).toEqual({ forward: 0, strafe: 0, turn: 0 });
  });

  test('pointercancel stops movement', () => {
    const { pad, win, input } = setup();
    pad.dispatch('pointerdown', touch(1, 50, 10));
    win.dispatch('pointercancel', touch(1, 50, 10));
    expect(input.state()).toEqual({ forward: 0, strafe: 0, turn: 0 });
  });

  test('blur and tab hide stop movement and drop the turn finger', () => {
    const { pad, win, doc, surface, input } = setup();
    pad.dispatch('pointerdown', touch(1, 50, 10));
    surface.dispatch('pointerdown', touch(2, 100, 300));
    win.dispatch('blur');
    expect(input.state().forward).toBe(0);
    win.dispatch('pointermove', touch(2, 300, 300));
    expect(input.consumeTurn()).toBe(0);
    pad.dispatch('pointerdown', touch(3, 50, 10));
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    expect(input.state().forward).toBe(0);
  });

  test('mouse pointers are ignored', () => {
    const { pad, surface, win, input } = setup();
    pad.dispatch('pointerdown', touch(1, 50, 10, 'mouse'));
    surface.dispatch('pointerdown', touch(2, 100, 300, 'mouse'));
    win.dispatch('pointermove', touch(2, 300, 300, 'mouse'));
    expect(input.state()).toEqual({ forward: 0, strafe: 0, turn: 0 });
    expect(input.consumeTurn()).toBe(0);
  });

  test('a surface drag of half the surface width turns 90°', () => {
    const { surface, win, input } = setup();
    surface.dispatch('pointerdown', touch(1, 100, 300));
    win.dispatch('pointermove', touch(1, 300, 320));
    expect(input.consumeTurn()).toBeCloseTo(Math.PI / 2, 9);
    expect(input.consumeTurn()).toBe(0);
  });

  test('a second surface finger is ignored', () => {
    const { surface, win, input } = setup();
    surface.dispatch('pointerdown', touch(1, 100, 300));
    surface.dispatch('pointerdown', touch(2, 100, 400));
    win.dispatch('pointermove', touch(2, 300, 400));
    expect(input.consumeTurn()).toBe(0);
    win.dispatch('pointermove', touch(1, 300, 300));
    expect(input.consumeTurn()).toBeCloseTo(Math.PI / 2, 9);
  });

  test('pad and surface work at once', () => {
    const { pad, surface, win, input } = setup();
    pad.dispatch('pointerdown', touch(1, 50, 10));
    surface.dispatch('pointerdown', touch(2, 100, 300));
    win.dispatch('pointermove', touch(2, 200, 300));
    expect(input.state().forward).toBe(1);
    expect(input.consumeTurn()).toBeCloseTo(Math.PI / 4, 9);
  });

  test('events on a pad before attachPad are ignored; after attaching they move', () => {
    const { pad, input } = setup({ attach: false });
    pad.dispatch('pointerdown', touch(1, 50, 10));
    expect(input.state().forward).toBe(0);
    input.attachPad(pad);
    pad.dispatch('pointerdown', touch(1, 50, 10));
    expect(input.state().forward).toBe(1);
  });

  test('the pad captures its finger, and a synthetic pointer that cannot be captured still works', () => {
    const { pad, win, input } = setup();
    pad.dispatch('pointerdown', touch(7, 50, 10));
    expect(pad.captured).toEqual([7]);
    win.dispatch('pointerup', touch(7, 50, 10));
    pad.setPointerCapture = () => {
      throw new DOMException('no active pointer', 'NotFoundError');
    };
    pad.dispatch('pointerdown', touch(8, 50, 90));
    expect(input.state().forward).toBe(-1);
  });
});
