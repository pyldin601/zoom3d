// Face framing (face-framing spec §3): turns detector face boxes into a smoothed square crop of the
// camera frame, so every disc shows a centred face at a consistent size. All values are source pixels.

/** Crop side as a multiple of the face box width. */
export const FACE_SCALE = 2.2;
/** The crop centre sits this fraction of its side above the face centre (headroom). */
export const HEADROOM = 0.1;
/** Smallest crop side: caps upscaling into the 256² output at 1.6×. */
export const MIN_SIDE = 160;
/** A new target closer than this fraction of the old side (centre) is ignored... */
export const DEAD_MOVE = 0.06;
/** ...unless its side differs by more than this fraction. */
export const DEAD_SIZE = 0.1;
/** Time constant of the exponential easing towards the target. */
export const EASE_MS = 600;
/** Without a face for this long, the target returns to the centred square. */
export const LOST_MS = 3000;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  size: number;
}

export interface Framing {
  /** Pass the fresh face box on detection frames, else null. Returns a reused rect: copy it to keep it. */
  update(face: Box | null, now: number): Rect;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function createFraming(frameW: number, frameH: number): Framing {
  const full = Math.min(frameW, frameH);
  const centred = (r: Rect) => {
    r.x = (frameW - full) / 2;
    r.y = (frameH - full) / 2;
    r.size = full;
  };
  const target: Rect = { x: 0, y: 0, size: 0 };
  const current: Rect = { x: 0, y: 0, size: 0 };
  const candidate: Rect = { x: 0, y: 0, size: 0 };
  centred(target);
  centred(current);
  let lastBoxAt = Number.NEGATIVE_INFINITY;
  let lastNow: number | null = null;

  const fromBox = (b: Box) => {
    const size = clamp(FACE_SCALE * b.w, MIN_SIDE, full);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2 - HEADROOM * size;
    candidate.size = size;
    candidate.x = clamp(cx - size / 2, 0, frameW - size);
    candidate.y = clamp(cy - size / 2, 0, frameH - size);
  };

  return {
    update(face, now) {
      if (face) {
        lastBoxAt = now;
        fromBox(face);
        const move = Math.hypot(
          candidate.x + candidate.size / 2 - (target.x + target.size / 2),
          candidate.y + candidate.size / 2 - (target.y + target.size / 2)
        );
        if (move > DEAD_MOVE * target.size || Math.abs(candidate.size - target.size) > DEAD_SIZE * target.size) {
          target.x = candidate.x;
          target.y = candidate.y;
          target.size = candidate.size;
        }
      } else if (now - lastBoxAt > LOST_MS) {
        centred(target);
      }
      const k = lastNow === null ? 0 : 1 - Math.exp(-(now - lastNow) / EASE_MS);
      lastNow = now;
      current.x += (target.x - current.x) * k;
      current.y += (target.y - current.y) * k;
      current.size += (target.size - current.size) * k;
      return current;
    },
  };
}
