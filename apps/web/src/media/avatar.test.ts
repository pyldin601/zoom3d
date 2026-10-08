import { AVATAR_MAX_CHARS, AVATAR_SIZE } from '@zoom3d/shared';
import { describe, expect, test, vi } from 'vitest';
import { AVATAR_KEY, loadAvatar, makeAvatar, saveAvatar } from './avatar';

const PIC = 'data:image/jpeg;base64,/9j/4AAQ';

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

describe('storage', () => {
  test('round-trips and removes', () => {
    const store = memory();
    saveAvatar(store, PIC);
    expect(store.data.get(AVATAR_KEY)).toBe(PIC);
    expect(loadAvatar(store)).toBe(PIC);
    saveAvatar(store, null);
    expect(store.data.has(AVATAR_KEY)).toBe(false);
    expect(loadAvatar(store)).toBeNull();
  });

  test('an invalid stored value is ignored', () => {
    const store = memory();
    store.data.set(AVATAR_KEY, 'javascript:alert(1)');
    expect(loadAvatar(store)).toBeNull();
  });

  test('missing or throwing storage is harmless', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    const throwing = { getItem: blocked, setItem: blocked, removeItem: blocked };
    expect(loadAvatar(throwing)).toBeNull();
    expect(loadAvatar(null)).toBeNull();
    expect(() => saveAvatar(throwing, PIC)).not.toThrow();
    expect(() => saveAvatar(null, null)).not.toThrow();
  });
});

/** A fake canvas whose JPEG output length depends on the requested quality. */
function fakeCanvas(lengthFor: (quality: number) => number) {
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  const toDataURL = vi.fn((_type: string, q: number) => {
    const prefix = 'data:image/jpeg;base64,';
    return prefix + 'A'.repeat(Math.max(lengthFor(q) - prefix.length, 4));
  });
  const canvas = { width: 0, height: 0, getContext: () => context, toDataURL };
  const document = { createElement: () => canvas } as unknown as Document;
  return { canvas, context, toDataURL, document };
}

const image = (width: number, height: number) => ({ width, height, close: vi.fn() });

describe('makeAvatar', () => {
  test('draws the centre square at AVATAR_SIZE on white and encodes JPEG', async () => {
    const { canvas, context, toDataURL, document } = fakeCanvas(() => 5000);
    const img = image(3000, 2000);
    const url = await makeAvatar(new Blob(), { decode: async () => img as never, document });
    expect(canvas.width).toBe(AVATAR_SIZE);
    expect(canvas.height).toBe(AVATAR_SIZE);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    expect(context.drawImage).toHaveBeenCalledWith(img, 500, 0, 2000, 2000, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    expect(img.close).toHaveBeenCalled();
  });

  test('steps quality down until the picture fits', async () => {
    const { toDataURL, document } = fakeCanvas((q) => (q > 0.6 ? AVATAR_MAX_CHARS + 1 : AVATAR_MAX_CHARS));
    const url = await makeAvatar(new Blob(), { decode: async () => image(100, 300) as never, document });
    expect(url.length).toBe(AVATAR_MAX_CHARS);
    expect(toDataURL.mock.calls.map(([, q]) => q)).toEqual([0.85, 0.75, 0.65, 0.55]);
  });

  test('rejects too_big when even the lowest quality does not fit', async () => {
    const { toDataURL, document } = fakeCanvas(() => AVATAR_MAX_CHARS + 1);
    await expect(
      makeAvatar(new Blob(), { decode: async () => image(10, 10) as never, document }),
    ).rejects.toThrow('too_big');
    expect(toDataURL.mock.calls.at(-1)?.[1]).toBeCloseTo(0.35);
  });

  test('rejects unreadable when the file does not decode', async () => {
    const { document } = fakeCanvas(() => 100);
    const decode = async () => {
      throw new DOMException('bad', 'InvalidStateError');
    };
    await expect(makeAvatar(new Blob(), { decode, document })).rejects.toThrow('unreadable');
  });
});
