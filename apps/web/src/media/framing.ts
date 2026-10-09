// Face framing (face-framing spec §3): turns detector face boxes into a smoothed square crop of the
// camera frame, so every disc shows a centred face at a consistent size. All values are source pixels.

/** Crop side as a multiple of the face box width. */
export const FACE_SCALE = 2.2;
/** Without a mouth keypoint, the crop centre sits this fraction of its side above the face centre. */
export const HEADROOM = 0.1;
/**
 * With a mouth keypoint, the mouth lands at (0.5, MOUTH_Y_IN_CROP) of the crop, so receivers know where the
 * mouth is on the disc (the held-items sip aims there). Single source of truth for that point.
 */
export const MOUTH_Y_IN_CROP = 0.72;
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
  /** Mouth centre in source pixels, when the detector found it. */
  mouth?: { x: number; y: number };
}

export interface Rect {
  x: number;
  y: number;
  size: number;
}

export interface Framing {
  /**
   * Pass the fresh face box on detection frames, else null; `searching` is false until the detector has loaded.
   * Returns a reused rect: copy it to keep it.
   */
  update(face: Box | null, now: number, searching?: boolean): Rect;
  /** Where the crop is heading. Reused: copy it to keep it. */
  readonly target: Rect;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** `start` is a rect remembered from an earlier visit; it is held until the face search begins. */
export function createFraming(frameW: number, frameH: number, start: Rect | null = null): Framing {
  const full = Math.min(frameW, frameH);
  const centred = (r: Rect) => {
    r.x = (frameW - full) / 2;
    r.y = (frameH - full) / 2;
    r.size = full;
  };
  const target: Rect = { x: 0, y: 0, size: 0 };
  const current: Rect = { x: 0, y: 0, size: 0 };
  const candidate: Rect = { x: 0, y: 0, size: 0 };
  const fits = (r: Rect) => r.size > 0 && r.x >= 0 && r.y >= 0 && r.x + r.size <= frameW && r.y + r.size <= frameH;
  const remembered = start !== null && fits(start);
  if (remembered) {
    Object.assign(target, start);
    Object.assign(current, start);
  } else {
    centred(target);
    centred(current);
  }
  // null: a remembered start not yet searched for, so not yet lost.
  let lastBoxAt: number | null = remembered ? null : Number.NEGATIVE_INFINITY;
  let lastNow: number | null = null;

  const fromBox = (b: Box) => {
    const size = clamp(FACE_SCALE * b.w, MIN_SIDE, full);
    const left = b.mouth ? b.mouth.x - size / 2 : b.x + b.w / 2 - size / 2;
    const top = b.mouth ? b.mouth.y - MOUTH_Y_IN_CROP * size : b.y + b.h / 2 - HEADROOM * size - size / 2;
    candidate.size = size;
    candidate.x = clamp(left, 0, frameW - size);
    candidate.y = clamp(top, 0, frameH - size);
  };

  return {
    target,
    update(face, now, searching = true) {
      if (lastBoxAt === null && searching) {
        lastBoxAt = now;
      }
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
      } else if (lastBoxAt !== null && now - lastBoxAt > LOST_MS) {
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
