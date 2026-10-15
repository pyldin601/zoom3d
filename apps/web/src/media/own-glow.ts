// Your own face's glow colour (avatar glow, D24): the framer's canvas scaled down to SAMPLE² and averaged, a few
// times a second. A full 256² read-back every frame would cost more than the whole glow.
import { rgb } from '../renderer/framebuffer';

/** The colour is read again at most this often (ms): a face's average changes slowly. */
export const OWN_GLOW_MS = 250;
const SAMPLE = 16;

/** The average of RGBA bytes, packed like rgb(). */
export function averageRgba(data: Uint8ClampedArray): number {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = data.length / 4 || 1;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i] as number;
    g += data[i + 1] as number;
    b += data[i + 2] as number;
  }
  return rgb(Math.round(r / n), Math.round(g / n), Math.round(b / n));
}

export interface OwnGlowSampler {
  /** The face's average colour at time `now` (ms), or null when it can't be read. */
  colour(now: number): number | null;
}

export function createOwnGlowSampler(face: CanvasImageSource, doc: Document): OwnGlowSampler {
  const canvas = doc.createElement('canvas');
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let readAt = Number.NEGATIVE_INFINITY;
  let last: number | null = null;
  return {
    colour(now) {
      if (!ctx) {
        return null;
      }
      if (now - readAt >= OWN_GLOW_MS) {
        readAt = now;
        ctx.drawImage(face, 0, 0, SAMPLE, SAMPLE);
        last = averageRgba(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
      }
      return last;
    },
  };
}
