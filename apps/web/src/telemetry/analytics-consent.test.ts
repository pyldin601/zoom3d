import { expect, test } from 'vitest';
import { ANALYTICS_KEY, forgetDeviceId, loadRememberedDeviceId, rememberDeviceId } from './analytics-consent';

function mapStorage(map: Map<string, string>) {
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test('round-trips the device id under zoom3d.analytics', () => {
  const map = new Map<string, string>();
  const storage = mapStorage(map);
  expect(loadRememberedDeviceId(storage)).toBeNull();
  rememberDeviceId(storage, 'abcdef-123');
  expect(ANALYTICS_KEY).toBe('zoom3d.analytics');
  expect(map.get(ANALYTICS_KEY)).toBe('abcdef-123');
  expect(loadRememberedDeviceId(storage)).toBe('abcdef-123');
  forgetDeviceId(storage);
  expect(loadRememberedDeviceId(storage)).toBeNull();
  expect(map.has(ANALYTICS_KEY)).toBe(false);
});

test('ignores a stored value too short to be a device id', () => {
  const map = new Map<string, string>();
  const storage = mapStorage(map);
  map.set(ANALYTICS_KEY, '');
  expect(loadRememberedDeviceId(storage)).toBeNull();
  map.set(ANALYTICS_KEY, 'abcd');
  expect(loadRememberedDeviceId(storage)).toBeNull();
  map.set(ANALYTICS_KEY, 'abcde');
  expect(loadRememberedDeviceId(storage)).toBe('abcde');
});

test('throwing or missing storage is tolerated', () => {
  const boom = () => {
    throw new Error('blocked');
  };
  expect(loadRememberedDeviceId({ getItem: boom })).toBeNull();
  expect(() => rememberDeviceId({ setItem: boom }, 'abcdef')).not.toThrow();
  expect(() => forgetDeviceId({ removeItem: boom })).not.toThrow();
  expect(loadRememberedDeviceId(null)).toBeNull();
  expect(() => rememberDeviceId(null, 'abcdef')).not.toThrow();
  expect(() => forgetDeviceId(null)).not.toThrow();
});
