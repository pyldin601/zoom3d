import { beforeEach, expect, test, vi } from 'vitest';
import { ANALYTICS_KEY } from './analytics-consent';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  track: vi.fn(),
  flush: vi.fn(),
  setTransport: vi.fn(),
  getDeviceId: vi.fn(() => undefined as string | undefined),
  setDeviceId: vi.fn(),
}));

const fakeSdk = () => ({
  init: sdk.init,
  track: sdk.track,
  flush: sdk.flush,
  setTransport: sdk.setTransport,
  getDeviceId: sdk.getDeviceId,
  setDeviceId: sdk.setDeviceId,
});

type Analytics = typeof import('./analytics');
let analytics: Analytics;
let map: Map<string, string>;
let storage: Storage;

beforeEach(async () => {
  vi.doMock('@amplitude/analytics-browser', fakeSdk);
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  map = new Map();
  storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as Storage;
  analytics = await import('./analytics');
});

const initOptions = () => sdk.init.mock.calls.at(0)?.at(1) as Record<string, unknown>;

test('starts with the remembered device id', async () => {
  map.set(ANALYTICS_KEY, 'stored-id-1');
  analytics.initAnalytics('key', 'v1', storage);
  await vi.dynamicImportSettled();
  expect(initOptions()).toEqual(expect.objectContaining({ deviceId: 'stored-id-1', identityStorage: 'none' }));
});

test('starts with a fresh random id when none is remembered', async () => {
  analytics.initAnalytics('key', 'v1', storage);
  await vi.dynamicImportSettled();
  expect(typeof initOptions().deviceId).toBe('string');
  expect(String(initOptions().deviceId).length).toBeGreaterThanOrEqual(5);
});

test('remembering saves the id the SDK runs with and reports consent', async () => {
  analytics.initAnalytics('key', 'v1', storage);
  await vi.dynamicImportSettled();
  analytics.setStatsRemembered(true);
  expect(map.get(ANALYTICS_KEY)).toBe(initOptions().deviceId);
  expect(sdk.track).toHaveBeenCalledWith('analytics_consent', { on: true });
  expect(analytics.statsSwitch()?.on).toBe(true);
});

test('remembering before the SDK loads saves the id it then starts with', async () => {
  analytics.initAnalytics('key', 'v1', storage);
  analytics.setStatsRemembered(true);
  const saved = map.get(ANALYTICS_KEY);
  expect(typeof saved).toBe('string');
  await vi.dynamicImportSettled();
  expect(initOptions().deviceId).toBe(saved);
});

test('forgetting before the SDK loads starts it with a fresh id', async () => {
  map.set(ANALYTICS_KEY, 'stored-id-1');
  analytics.initAnalytics('key', 'v1', storage);
  analytics.setStatsRemembered(false);
  await vi.dynamicImportSettled();
  expect(map.has(ANALYTICS_KEY)).toBe(false);
  expect(typeof initOptions().deviceId).toBe('string');
  expect(initOptions().deviceId).not.toBe('stored-id-1');
});

test('remembering then forgetting before the SDK loads saves nothing', async () => {
  analytics.initAnalytics('key', 'v1', storage);
  analytics.setStatsRemembered(true);
  analytics.setStatsRemembered(false);
  await vi.dynamicImportSettled();
  expect(map.has(ANALYTICS_KEY)).toBe(false);
});

test('forgetting removes the id and switches to a fresh one', async () => {
  map.set(ANALYTICS_KEY, 'stored-id-1');
  analytics.initAnalytics('key', 'v1', storage);
  await vi.dynamicImportSettled();
  analytics.setStatsRemembered(false);
  expect(map.has(ANALYTICS_KEY)).toBe(false);
  expect(sdk.setDeviceId).toHaveBeenCalledOnce();
  const fresh = sdk.setDeviceId.mock.calls.at(0)?.at(0);
  expect(typeof fresh).toBe('string');
  expect(fresh).not.toBe('stored-id-1');
  const consentCall = sdk.track.mock.calls.findIndex((c) => c.at(0) === 'analytics_consent');
  expect(sdk.track.mock.calls.at(consentCall)).toEqual(['analytics_consent', { on: false }]);
  expect(sdk.track.mock.invocationCallOrder.at(consentCall)).toBeGreaterThan(
    sdk.setDeviceId.mock.invocationCallOrder.at(0) ?? Number.POSITIVE_INFINITY
  );
  expect(analytics.statsSwitch()?.on).toBe(false);
});

test('the switch is absent when analytics is off', () => {
  analytics.initAnalytics(undefined, 'v1', storage);
  expect(analytics.statsSwitch()).toBeNull();
  analytics.setStatsRemembered(true);
  expect(map.has(ANALYTICS_KEY)).toBe(false);
});

test('the switch is absent and inert when the SDK fails to load', async () => {
  vi.doMock('@amplitude/analytics-browser', () => {
    throw new Error('chunk failed');
  });
  vi.resetModules();
  analytics = await import('./analytics');
  analytics.initAnalytics('key', 'v1', storage);
  await vi.dynamicImportSettled();
  expect(analytics.statsSwitch()).toBeNull();
  expect(() => analytics.setStatsRemembered(true)).not.toThrow();
  expect(map.has(ANALYTICS_KEY)).toBe(false);
});

test("blocked storage: toggling doesn't throw and reads as off", async () => {
  analytics.initAnalytics('key', 'v1', null);
  await vi.dynamicImportSettled();
  expect(() => analytics.setStatsRemembered(true)).not.toThrow();
  expect(analytics.statsSwitch()?.on).toBe(false);
});
