// The local player's face as a disc texture, for their own disc seen through a portal: the framer's canvas, as peers
// get it, read back at most once per video frame into one texture reused for the whole visit.
import { FACE_SIZE } from './faces';
import { VIDEO_POLL_MS } from './video-frames';

export interface OwnFaceSampler {
  /** FACE_SIZE² texels of the face at time `now` (ms), or null when it can't be read. */
  texels(now: number): Uint32Array | null;
}

export function createOwnFaceSampler(face: CanvasImageSource, doc: Document): OwnFaceSampler {
  const canvas = doc.createElement('canvas');
  canvas.width = FACE_SIZE;
  canvas.height = FACE_SIZE;
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
        ctx.drawImage(face, 0, 0, FACE_SIZE, FACE_SIZE);
        const { data } = ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
        texels.set(new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4));
      }
      return texels;
    },
  };
}
