// @vitest-environment happy-dom
// The real SDK with our options must store nothing on the device: no cookie, local or session storage, IndexedDB.
import * as amplitude from '@amplitude/analytics-browser';
import { afterEach, expect, test, vi } from 'vitest';
import { amplitudeOptions } from './analytics';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the SDK with our options touches no storage on the device', async () => {
  const open = vi.fn();
  vi.stubGlobal('indexedDB', { open, databases: vi.fn(async () => []) });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}'))
  );
  localStorage.clear();
  sessionStorage.clear();
  await amplitude.init('test-key-123', amplitudeOptions('v1', 'device-id-1')).promise;
  await new Promise((r) => setTimeout(r, 50));
  expect(amplitude.getDeviceId()).toBe('device-id-1');
  expect(open).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(document.cookie).toBe('');
});
