// Cameras and microphones as the lobby shows them (lobby spec §3.1, §3.6).

/** Why a device can't be used. Busy is the only one worth retrying without a reload. */
export type DeviceProblem = 'insecure' | 'blocked' | 'missing' | 'busy';

export interface Device {
  id: string;
  label: string;
}

const PROBLEMS: Record<string, DeviceProblem> = {
  NotAllowedError: 'blocked',
  SecurityError: 'blocked',
  NotFoundError: 'missing',
  OverconstrainedError: 'missing',
};

export function deviceProblem(err: unknown): DeviceProblem {
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  return PROBLEMS[name] ?? 'busy';
}

/** Devices of one kind; before permission is granted labels are empty, so they get numbered names. */
export function listDevices(infos: readonly MediaDeviceInfo[], kind: 'videoinput' | 'audioinput'): Device[] {
  const noun = kind === 'videoinput' ? 'Camera' : 'Microphone';
  return infos
    .filter((d) => d.kind === kind && d.deviceId !== '')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `${noun} ${i + 1}` }));
}
