// The analytics device id of a visitor who opted in to being remembered (D20, 2026-11-08). The key's presence is the
// opt-in; someone who never opts in has no key at all. Storage may be missing or throw (private mode, blocked).

export const ANALYTICS_KEY = 'zoom3d.analytics';

/** Amplitude's default `minIdLength`: a shorter id would be rejected, so it can't be a remembered one. */
const MIN_DEVICE_ID_CHARS = 5;

export function loadRememberedDeviceId(storage: Pick<Storage, 'getItem'> | null): string | null {
  try {
    const id = storage?.getItem(ANALYTICS_KEY) ?? null;
    return id !== null && id.length >= MIN_DEVICE_ID_CHARS ? id : null;
  } catch {
    return null;
  }
}

export function rememberDeviceId(storage: Pick<Storage, 'setItem'> | null, deviceId: string): void {
  try {
    storage?.setItem(ANALYTICS_KEY, deviceId);
  } catch {
    // Not remembered; the next visit counts as a new visitor, as without the opt-in.
  }
}

export function forgetDeviceId(storage: Pick<Storage, 'removeItem'> | null): void {
  try {
    storage?.removeItem(ANALYTICS_KEY);
  } catch {
    // Storage that can't be reached holds nothing to forget.
  }
}
