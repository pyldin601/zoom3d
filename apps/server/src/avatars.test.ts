import { createHash } from 'node:crypto';
import { isAvatarId } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { AvatarStore, avatarId } from './avatars';

const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const OTHER = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAg==';

test('an avatar id is the first 22 characters of the base64url SHA-256 of the data URL', () => {
  const id = avatarId(PIC);
  expect(id).toBe(createHash('sha256').update(PIC).digest('base64url').slice(0, 22));
  expect(isAvatarId(id)).toBe(true);
  expect(avatarId(OTHER)).not.toBe(id);
});

test('the store serves the decoded JPEG bytes', () => {
  const store = new AvatarStore();
  const id = store.add(PIC);
  expect(id).toBe(avatarId(PIC));
  expect(store.get(id)).toEqual(Buffer.from('/9j/4AAQSkZJRgABAQ==', 'base64'));
  expect(store.get(avatarId(OTHER))).toBeNull();
});

test('people with the same picture share one entry until the last of them lets go', () => {
  const store = new AvatarStore();
  const id = store.add(PIC);
  expect(store.add(PIC)).toBe(id);
  store.release(id);
  expect(store.get(id)).not.toBeNull();
  store.release(id);
  expect(store.get(id)).toBeNull();
  // Releasing again (or an unknown id) is harmless.
  store.release(id);
  store.release('nope');
  expect(store.add(PIC)).toBe(id);
  expect(store.get(id)).not.toBeNull();
});
