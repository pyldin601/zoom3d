// Anonymous product analytics (Amplitude). Off unless the build sets VITE_AMPLITUDE_API_KEY.
// Storage-free unless the visitor opts in (ePrivacy: no consent needed when nothing is read from or written to the
// device): the unsent-event queue always lives in memory, and so does the device id, so one page load is one user.
// A visitor who ticks "Remember this browser" consents to one key, the device id (`analytics-consent.ts`), so later
// visits are the same user; sessions still start afresh on each load. "Start a party" stays in the page to keep the
// onboarding funnel in one load. No IP, no autocapture, and never names or room ids.
import type { Types } from '@amplitude/analytics-browser';
import type { HeldItem } from '@zoom3d/shared';
import { forgetDeviceId, loadRememberedDeviceId, rememberDeviceId } from './analytics-consent';
import type { MediaOutcome } from './onboarding';

export type AnalyticsEvent =
  // Onboarding
  | { name: 'landing_viewed' }
  | { name: 'party_started' }
  | { name: 'lobby_viewed'; entry: 'host' | 'invite' }
  | { name: 'media_permission'; cam: MediaOutcome; mic: MediaOutcome }
  | { name: 'peer_met'; afterS: number }
  // Sessions
  | { name: 'room_joined'; peers: number }
  | { name: 'room_left'; durationS: number; peersMax: number; drops: number }
  // Social features
  | { name: 'drink_picked'; item: HeldItem }
  | { name: 'sip' }
  | { name: 'cheers' }
  | { name: 'boombox_started' }
  | { name: 'portals_toggled'; on: boolean }
  // Connection health
  | { name: 'connection_lost' }
  | { name: 'connection_restored'; downS: number }
  | { name: 'connection_failed'; reason: string; joined: boolean }
  | { name: 'webrtc_failed'; stage: 'negotiation' | 'signal' | 'ice' }
  | { name: 'face_detector_unavailable' }
  // Privacy
  | { name: 'analytics_consent'; on: boolean };

/** The "Remember this browser" checkbox: whether the device id is kept across visits. */
export interface StatsSwitch {
  on: boolean;
  onChange(on: boolean): void;
}

type Amplitude = typeof import('@amplitude/analytics-browser');

// The SDK is a large chunk, loaded only when a key is set. Until it arrives, events wait in `queue`;
// both stay null when analytics is off.
let amp: Amplitude | null = null;
let queue: AnalyticsEvent[] | null = null;
let storage: Storage | null = null;
/** Ours, not read back from the SDK: its init is async, and an opt-in may come before the SDK has loaded. */
let deviceId = '';

type EventStorage = NonNullable<Types.BrowserOptions['storageProvider']>;
type StoredEvents = Awaited<ReturnType<EventStorage['get']>>;

/** Replaces the SDK's default localStorage queue for unsent events. */
function memoryStorage(): EventStorage {
  const data = new Map<string, StoredEvents>();
  return {
    isEnabled: async () => true,
    get: async (key) => data.get(key),
    getRaw: async (key) => (data.has(key) ? JSON.stringify(data.get(key)) : undefined),
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
    reset: async () => data.clear(),
  };
}

function send(sdk: Amplitude, e: AnalyticsEvent): void {
  const { name, ...props } = e;
  sdk.track(name, props);
}

export function initAnalytics(
  apiKey: string | undefined,
  appVersion: string | undefined,
  pageStorage: Storage | null
): void {
  if (!apiKey) {
    return;
  }
  storage = pageStorage;
  queue = [];
  deviceId = loadRememberedDeviceId(storage) ?? crypto.randomUUID();
  import('@amplitude/analytics-browser').then(
    (sdk) => {
      sdk.init(apiKey, {
        appVersion,
        // Read when the SDK arrives: an opt-out before then has already replaced the remembered id.
        deviceId,
        autocapture: false,
        identityStorage: 'none',
        storageProvider: memoryStorage(),
        trackingOptions: { ipAddress: false },
        // Remote config could switch autocapture back on from Amplitude's UI.
        remoteConfig: { fetchRemoteConfig: false },
        enableDiagnostics: false,
      });
      amp = sdk;
      for (const e of queue ?? []) {
        send(sdk, e);
      }
      queue = [];
    },
    (err) => {
      console.warn('analytics unavailable', err);
      queue = null;
    }
  );
}

/** Null while analytics is off or its SDK failed to load: then there is nothing to remember. */
export function statsSwitch(): StatsSwitch | null {
  if (!amp && !queue) {
    return null;
  }
  return { on: loadRememberedDeviceId(storage) !== null, onChange: setStatsRemembered };
}

export function setStatsRemembered(on: boolean): void {
  if (!amp && !queue) {
    return;
  }
  if (on) {
    rememberDeviceId(storage, deviceId);
  } else {
    forgetDeviceId(storage);
    // The rest of this visit must not be tied to the id that was remembered.
    deviceId = crypto.randomUUID();
    amp?.setDeviceId(deviceId);
  }
  track({ name: 'analytics_consent', on });
}

export function track(e: AnalyticsEvent): void {
  if (amp) {
    send(amp, e);
  } else {
    queue?.push(e);
  }
}

/** The page is being hidden or closed: switch to sendBeacon so the last events survive, and send them now. */
export function flushOnHide(): void {
  amp?.setTransport('beacon');
  amp?.flush();
}
