// The boombox volume, remembered per browser; storage may be missing or throw (private mode, blocked).

export const BOOMBOX_VOLUME_KEY = 'zoom3d.boombox.volume';

const clamp = (v: number) => Math.min(Math.max(v, 0), 1);

/** 0..1; nothing saved, junk or unreadable storage means full volume. */
export function loadBoomboxVolume(storage: Pick<Storage, 'getItem'> | null): number {
  try {
    const raw = storage?.getItem(BOOMBOX_VOLUME_KEY);
    const v = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(v) ? clamp(v) : 1;
  } catch {
    return 1;
  }
}

export function saveBoomboxVolume(storage: Pick<Storage, 'setItem'> | null, volume: number): void {
  try {
    storage?.setItem(BOOMBOX_VOLUME_KEY, String(clamp(volume)));
  } catch {
    // Not remembered; it still applies for this session.
  }
}
