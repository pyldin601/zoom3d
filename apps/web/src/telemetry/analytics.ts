// Anonymous product analytics (Amplitude). Off unless the build sets VITE_AMPLITUDE_API_KEY.
// Storage-free (ePrivacy: no consent needed when nothing is read from or written to the device): the device id and the
// unsent-event queue live in memory, so one page load is one user. "Start a party" stays in the page to keep the
// onboarding funnel in one load. No IP, no autocapture, and never names or room ids.
import type { Types } from '@amplitude/analytics-browser';
import type { HeldItem } from '@zoom3d/shared';
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
  // Connection health
  | { name: 'connection_lost' }
  | { name: 'connection_restored'; downS: number }
  | { name: 'connection_failed'; reason: string; joined: boolean }
  | { name: 'webrtc_failed'; stage: 'negotiation' | 'signal' | 'ice' }
  | { name: 'face_detector_unavailable' };

type Amplitude = typeof import('@amplitude/analytics-browser');

// The SDK is a large chunk, loaded only when a key is set. Until it arrives, events wait in `queue`;
// both stay null when analytics is off.
let amp: Amplitude | null = null;
let queue: AnalyticsEvent[] | null = null;

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

export function initAnalytics(apiKey: string | undefined, appVersion: string | undefined): void {
  if (!apiKey) {
    return;
  }
  queue = [];
  import('@amplitude/analytics-browser').then(
    (sdk) => {
      sdk.init(apiKey, {
        appVersion,
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
