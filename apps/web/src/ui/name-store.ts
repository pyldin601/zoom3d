// The name typed in the lobby, remembered per browser; storage may be missing or throw (private mode, blocked).

export const NAME_KEY = 'zoom3d.name';

export function loadName(storage: Pick<Storage, 'getItem'> | null): string {
  try {
    return storage?.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveName(storage: Pick<Storage, 'setItem'> | null, name: string): void {
  try {
    storage?.setItem(NAME_KEY, name);
  } catch {
    // Not remembered; the lobby just starts empty next time.
  }
}
