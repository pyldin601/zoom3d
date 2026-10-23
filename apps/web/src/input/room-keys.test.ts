import { describe, expect, test } from 'vitest';
import { type RoomKeyState, roomKey } from './room-keys';

const IN_ROOM: RoomKeyState = { inRoom: true, hasBoombox: true };
const RECONNECTING: RoomKeyState = { inRoom: false, hasBoombox: true };
const press = (code: string, over: Partial<KeyboardEvent> = {}) => ({
  code,
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target: null,
  ...over,
});

describe('in the room', () => {
  test('each shortcut means its action', () => {
    expect(roomKey(press('Backquote'), IN_ROOM)).toEqual({ kind: 'console' });
    expect(roomKey(press('Tab'), IN_ROOM)).toEqual({ kind: 'map', repeat: false });
    expect(roomKey(press('KeyB'), IN_ROOM)).toEqual({ kind: 'boombox' });
    expect(roomKey(press('Digit2'), IN_ROOM)).toEqual({ kind: 'drink', item: 'coffee', code: 'Digit2' });
    expect(roomKey(press('Numpad0'), IN_ROOM)).toEqual({ kind: 'drink', item: null, code: 'Numpad0' });
    expect(roomKey(press('KeyM'), IN_ROOM)).toEqual({ kind: 'media', control: 'mic' });
    expect(roomKey(press('KeyC'), IN_ROOM)).toEqual({ kind: 'media', control: 'cam' });
    expect(roomKey(press('KeyW'), IN_ROOM)).toBeNull();
  });

  test('a held key acts once; a held Tab is still the map, so it never moves the focus', () => {
    for (const code of ['Backquote', 'KeyB', 'Digit1', 'KeyM']) {
      expect(roomKey(press(code, { repeat: true }), IN_ROOM)).toBeNull();
    }
    expect(roomKey(press('Tab', { repeat: true }), IN_ROOM)).toEqual({ kind: 'map', repeat: true });
  });

  test('browser shortcuts (Cmd+B, Ctrl+1, Alt+M) are left alone', () => {
    expect(roomKey(press('KeyB', { metaKey: true }), IN_ROOM)).toBeNull();
    expect(roomKey(press('Digit1', { ctrlKey: true }), IN_ROOM)).toBeNull();
    expect(roomKey(press('KeyM', { altKey: true }), IN_ROOM)).toBeNull();
  });

  test('a focused input keeps its keys; the console select only keeps M and C', () => {
    const input = { tagName: 'INPUT' } as unknown as EventTarget;
    const select = { tagName: 'SELECT' } as unknown as EventTarget;
    for (const code of ['Backquote', 'Tab', 'KeyB', 'Digit1', 'KeyM']) {
      expect(roomKey(press(code, { target: input }), IN_ROOM)).toBeNull();
    }
    expect(roomKey(press('Backquote', { target: select }), IN_ROOM)).toEqual({ kind: 'console' });
    expect(roomKey(press('KeyM', { target: select }), IN_ROOM)).toBeNull();
  });
});

test('reconnecting, only the boombox key works: the music is local', () => {
  expect(roomKey(press('KeyB'), RECONNECTING)).toEqual({ kind: 'boombox' });
  for (const code of ['Backquote', 'Tab', 'Digit1', 'KeyM']) {
    expect(roomKey(press(code), RECONNECTING)).toBeNull();
  }
});

test('without a boombox, B does nothing', () => {
  expect(roomKey(press('KeyB'), { inRoom: true, hasBoombox: false })).toBeNull();
});

describe('the kick (ball spec §7)', () => {
  test('Space kicks in the room', () => {
    expect(roomKey(press('Space'), IN_ROOM)).toEqual({ kind: 'kick' });
  });

  test('a held, modified or out-of-room Space does not', () => {
    expect(roomKey(press('Space', { repeat: true }), IN_ROOM)).toBeNull();
    expect(roomKey(press('Space', { ctrlKey: true }), IN_ROOM)).toBeNull();
    expect(roomKey(press('Space'), RECONNECTING)).toBeNull();
  });

  test('Space on a focused form control keeps its own meaning', () => {
    for (const tagName of ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA']) {
      expect(roomKey(press('Space', { target: { tagName } as unknown as EventTarget }), IN_ROOM)).toBeNull();
    }
  });
});
