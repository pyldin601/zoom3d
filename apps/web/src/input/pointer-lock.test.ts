import { expect, test, vi } from 'vitest';
import { lockPointer } from './pointer-lock';

test('a refused lock (clicked right after Esc) is caught, not left as an unhandled rejection', () => {
  const refusal = Promise.reject(
    new DOMException('Pointer lock cannot be acquired immediately after the user has exited the lock.')
  );
  const handled = vi.spyOn(refusal, 'catch');
  const el = { requestPointerLock: vi.fn(() => refusal) };
  lockPointer(el);
  expect(el.requestPointerLock).toHaveBeenCalledTimes(1);
  expect(handled).toHaveBeenCalledTimes(1);
});

test('browsers whose requestPointerLock returns nothing still lock', () => {
  const el = { requestPointerLock: vi.fn(() => undefined) };
  expect(() => lockPointer(el)).not.toThrow();
  expect(el.requestPointerLock).toHaveBeenCalledTimes(1);
});
