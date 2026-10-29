// The local player's face as a disc texture, for their own disc seen through a portal: the framer's canvas, as peers
// get it, read back at most once per video frame into one texture reused for the whole visit. The caller reads it
// only while a window shows the disc.
import { FACE_SIZE } from './faces';
import { VIDEO_POLL_MS } from './video-frames';

/**
 * Read back at half the texture's side, then doubled: a quarter of the readback and of the garbage getImageData
 * allocates (it can't fill a buffer of ours), and a disc seen through a doorway is never close enough to tell.
 */
export const OWN_FACE_READ = FACE_SIZE / 2;

export interface OwnFaceSampler {
  /** FACE_SIZE² texels of the face at time `now` (ms), or null when it can't be read. */
  texels(now: number): Uint32Array | null;
}

export function createOwnFaceSampler(face: CanvasImageSource, doc: Document): OwnFaceSampler {
  const canvas = doc.createElement('canvas');
  canvas.width = OWN_FACE_READ;
  canvas.height = OWN_FACE_READ;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const texels = new Uint32Array(FACE_SIZE * FACE_SIZE);
  let readAt = Number.NEGATIVE_INFINITY;
  return {
    texels(now) {
      if (!ctx) {
        return null;
      }
      if (now - readAt >= VIDEO_POLL_MS) {
        readAt = now;
        ctx.drawImage(face, 0, 0, OWN_FACE_READ, OWN_FACE_READ);
        const { data } = ctx.getImageData(0, 0, OWN_FACE_READ, OWN_FACE_READ);
        doubleInto(texels, new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4));
      }
      return texels;
    },
  };
}

/** Each OWN_FACE_READ² texel of `read` becomes a 2×2 block of the FACE_SIZE² `out`. */
function doubleInto(out: Uint32Array, read: Uint32Array): void {
  for (let y = 0; y < FACE_SIZE; y++) {
    const from = (y >> 1) * OWN_FACE_READ;
    const to = y * FACE_SIZE;
    for (let x = 0; x < FACE_SIZE; x++) {
      out[to + x] = read[from + (x >> 1)] as number;
    }
  }
}
