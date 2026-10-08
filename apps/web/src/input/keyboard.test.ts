import { describe, expect, test } from 'vitest';
import { createInput } from './keyboard';

class FakeTarget {
  listeners = new Map<string, EventListener[]>();
  visibilityState: DocumentVisibilityState = 'visible';
  pointerLockElement: Element | null = null;
  addEventListener(type: string, fn: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, event: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event as Event);
  }
}

function setup() {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const input = createInput(win, doc);
  const key = (type: 'keydown' | 'keyup', code: string) => win.dispatch(type, { code, preventDefault() {} });
  return { win, doc, input, key };
}

describe('createInput', () => {
  test('W moves forward and W+S cancel out', () => {
    const { input, key } = setup();
    key('keydown', 'KeyW');
    expect(input.state().forward).toBe(1);
    key('keydown', 'KeyS');
    expect(input.state().forward).toBe(0);
    key('keyup', 'KeyW');
    expect(input.state().forward).toBe(-1);
  });

  test('arrows and Q/E turn, A/D strafe', () => {
    const { input, key } = setup();
    key('keydown', 'ArrowRight');
    expect(input.state().turn).toBe(1);
    key('keyup', 'ArrowRight');
    key('keydown', 'KeyQ');
    expect(input.state().turn).toBe(-1);
    key('keydown', 'KeyD');
    expect(input.state().strafe).toBe(1);
  });

  test('window blur releases held keys', () => {
    const { win, input, key } = setup();
    key('keydown', 'KeyW');
    win.dispatch('blur');
    expect(input.state().forward).toBe(0);
  });

  test('hiding the tab releases held keys', () => {
    const { doc, input, key } = setup();
    key('keydown', 'KeyW');
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    expect(input.state().forward).toBe(0);
  });

  test('mouse turns only while pointer-locked and is consumed once', () => {
    const { doc, input } = setup();
    doc.dispatch('mousemove', { movementX: 100 });
    expect(input.consumeMouseTurn()).toBe(0);
    doc.pointerLockElement = {} as Element;
    doc.dispatch('mousemove', { movementX: 100 });
    expect(input.consumeMouseTurn()).toBeCloseTo(0.25);
    expect(input.consumeMouseTurn()).toBe(0);
  });
});
