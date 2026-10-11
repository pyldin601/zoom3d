import { describe, expect, test } from 'vitest';
import { mediaKey } from './media-keys';

const key = (code: string, over: Partial<KeyboardEvent> = {}) =>
  ({ code, repeat: false, metaKey: false, ctrlKey: false, altKey: false, target: null, ...over }) as KeyboardEvent;

describe('mediaKey', () => {
  test('M toggles the mic, C the camera', () => {
    expect(mediaKey(key('KeyM'))).toBe('mic');
    expect(mediaKey(key('KeyC'))).toBe('cam');
  });

  test('other keys, including Tab (the map), are not media keys', () => {
    for (const code of ['Tab', 'KeyB', 'KeyW', 'Digit1', 'Backquote']) {
      expect(mediaKey(key(code))).toBeNull();
    }
  });

  test('a held key toggles once, not on every repeat', () => {
    expect(mediaKey(key('KeyM', { repeat: true }))).toBeNull();
  });

  test('browser and OS shortcuts are left alone (Cmd+C copies)', () => {
    for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(mediaKey(key('KeyC', { [mod]: true }))).toBeNull();
    }
  });

  test('typing in a text field types, it does not toggle', () => {
    const input = { tagName: 'INPUT' } as unknown as EventTarget;
    expect(mediaKey(key('KeyM', { target: input }))).toBeNull();
  });
});
