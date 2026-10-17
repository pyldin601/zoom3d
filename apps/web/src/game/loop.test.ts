import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { startLoop } from './loop';

describe('startLoop', () => {
  /** Pending animation frames by id, run in order by `runFrame`. */
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 0;

  beforeEach(() => {
    pending.clear();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      pending.set(++nextId, cb);
      return nextId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const runFrame = (now: number) => {
    const next = pending.entries().next();
    if (next.done) {
      throw new Error('no frame scheduled');
    }
    const [id, cb] = next.value;
    pending.delete(id);
    cb(now);
  };

  test('ticks with the seconds since the last frame, 0 at first', () => {
    const dts: number[] = [];
    startLoop((dt) => dts.push(dt));
    runFrame(1000);
    runFrame(1016);
    expect(dts).toEqual([0, 0.016]);
  });

  test('a tick that throws still gets the next frame', () => {
    let calls = 0;
    startLoop(() => {
      calls++;
      if (calls === 1) {
        throw new Error('boom');
      }
    });
    expect(() => runFrame(0)).toThrow('boom');
    runFrame(16);
    expect(calls).toBe(2);
  });

  test('stop ends the loop, also from inside a tick', () => {
    const stop = startLoop(() => stop());
    runFrame(0);
    expect(pending.size).toBe(0);
  });
});
