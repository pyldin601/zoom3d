// Slow light's faces (D41): the last seconds of a face's video, so a face far away is seen as late as its light. A
// far face is small on screen, so frames are kept smaller the older they get: 128² for about a second, then 64² every
// other frame for about eight, the longest light time at the slowest c. Allocated on the first frame, about 4 MB.
import { createStateRing } from '../game/seen-state';
import { FACE_SIZE } from './faces';

export const NEAR_FACE_SIZE = 128;
export const FAR_FACE_SIZE = 64;
/** About a second of frames at 30 fps. */
const NEAR_FRAMES = 32;
/** About eight seconds at 15 fps: the far ring keeps every other frame. */
const FAR_FRAMES = 128;
/** Camera on and off changes within the longest light time. */
const MARK_CAPACITY = 16;

export interface FaceHistory {
  /** Keeps a FACE_SIZE² frame copied at `t`. */
  record(t: number, texels: Uint32Array): void;
  /** From `t` the face shows its video (`live`), or its avatar or initials (the camera off or stalled). */
  mark(t: number, live: boolean): void;
  /**
   * The frame shown at `t`, NEAR_FACE_SIZE² or FAR_FACE_SIZE², or null where the face showed no video then. Before the
   * oldest frame, the oldest. Reused: read it before the next record.
   */
  at(t: number): Uint32Array | null;
  /** Whether any frame is kept. */
  readonly empty: boolean;
  clear(): void;
}

interface FrameRing {
  frames: Uint32Array[];
  times: Float64Array;
  next: number;
  count: number;
}

const createRing = (frames: number, size: number): FrameRing => ({
  frames: Array.from({ length: frames }, () => new Uint32Array(size * size)),
  times: new Float64Array(frames),
  next: 0,
  count: 0,
});

/** Halves `from` (a `fromSize`² face) into `to` by averaging each 2×2 block, channel by channel. */
function halve(from: Uint32Array, fromSize: number, to: Uint32Array): void {
  const size = fromSize / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = 2 * y * fromSize + 2 * x;
      const a = from[i] as number;
      const b = from[i + 1] as number;
      const c = from[i + fromSize] as number;
      const d = from[i + fromSize + 1] as number;
      let out = 0;
      for (let shift = 0; shift < 32; shift += 8) {
        const sum = ((a >>> shift) & 0xff) + ((b >>> shift) & 0xff) + ((c >>> shift) & 0xff) + ((d >>> shift) & 0xff);
        out |= ((sum + 2) >> 2) << shift;
      }
      to[y * size + x] = out >>> 0;
    }
  }
}

/** The newest frame of `ring` stamped at or before `t`, or null when all are later (or none is kept). */
function newestAtOrBefore(ring: FrameRing, t: number): Uint32Array | null {
  const capacity = ring.frames.length;
  for (let back = 0; back < ring.count; back++) {
    const slot = (ring.next - 1 - back + capacity) % capacity;
    if ((ring.times[slot] as number) <= t) {
      return ring.frames.at(slot) ?? null;
    }
  }
  return null;
}

const oldestOf = (ring: FrameRing): Uint32Array | null =>
  ring.count === 0
    ? null
    : (ring.frames.at((ring.next - ring.count + ring.frames.length) % ring.frames.length) ?? null);

/** Puts the next slot of `ring` at `t` and returns its frame to fill. */
function nextSlot(ring: FrameRing, t: number): Uint32Array {
  const frame = ring.frames.at(ring.next) as Uint32Array;
  ring.times[ring.next] = t;
  ring.next = (ring.next + 1) % ring.frames.length;
  ring.count = Math.min(ring.frames.length, ring.count + 1);
  return frame;
}

export function createFaceHistory(): FaceHistory {
  let near: FrameRing | null = null;
  let far: FrameRing | null = null;
  /** Counts recorded frames: every other one goes into the far ring too. */
  let recorded = 0;
  const marks = createStateRing<{ live: boolean }>(
    MARK_CAPACITY,
    () => ({ live: true }),
    (from, to) => {
      to.live = from.live;
    },
    (a, b) => a.live === b.live
  );
  const marking = { live: true };
  const half = new Uint32Array(NEAR_FACE_SIZE * NEAR_FACE_SIZE);
  return {
    record(t, texels) {
      near ??= createRing(NEAR_FRAMES, NEAR_FACE_SIZE);
      far ??= createRing(FAR_FRAMES, FAR_FACE_SIZE);
      const nearFrame = nextSlot(near, t);
      halve(texels, FACE_SIZE, nearFrame);
      if (recorded++ % 2 === 0) {
        half.set(nearFrame);
        halve(half, NEAR_FACE_SIZE, nextSlot(far, t));
      }
    },
    mark(t, live) {
      marking.live = live;
      marks.push(t, marking);
    },
    at(t) {
      if (near === null || far === null || near.count === 0 || (t >= marks.oldestAt && !marks.at(t).live)) {
        return null;
      }
      return newestAtOrBefore(near, t) ?? newestAtOrBefore(far, t) ?? oldestOf(far) ?? oldestOf(near);
    },
    get empty() {
      return near === null || near.count === 0;
    },
    clear() {
      if (near) {
        near.count = 0;
      }
      if (far) {
        far.count = 0;
      }
      marks.clear();
      recorded = 0;
    },
  };
}
