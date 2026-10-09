// The optional avatar picture shown instead of initials while the camera is off (spec §8.1):
// a small JPEG data URL, kept per browser and sent in `join`.
import { AVATAR_SIZE, isValidAvatar } from '@zoom3d/shared';
import { squareCrop } from './faces';

export const AVATAR_KEY = 'zoom3d.avatar';
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];

type Decoded = CanvasImageSource & { width: number; height: number; close?: () => void };

export interface AvatarDeps {
  decode?: (blob: Blob) => Promise<Decoded>;
  document?: Document;
}

export function loadAvatar(storage: Pick<Storage, 'getItem'> | null): string | null {
  try {
    const v = storage?.getItem(AVATAR_KEY);
    return isValidAvatar(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveAvatar(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, avatar: string | null): void {
  try {
    if (avatar === null) {
      storage?.removeItem(AVATAR_KEY);
    } else {
      storage?.setItem(AVATAR_KEY, avatar);
    }
  } catch {
    // Not remembered; it is still used for this join.
  }
}

/** Centre square of the image at AVATAR_SIZE², as the best JPEG quality that fits. */
export async function makeAvatar(blob: Blob, deps: AvatarDeps = {}): Promise<string> {
  const decode = deps.decode ?? ((b: Blob) => createImageBitmap(b));
  let img: Decoded;
  try {
    img = await decode(blob);
  } catch {
    throw new Error('unreadable');
  }
  const canvas = (deps.document ?? document).createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  // JPEG has no alpha: transparent pixels would otherwise turn black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const { sx, sy, size } = squareCrop(img.width, img.height);
  ctx.drawImage(img, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  img.close?.();
  for (const q of QUALITIES) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (isValidAvatar(url)) {
      return url;
    }
  }
  throw new Error('too_big');
}
