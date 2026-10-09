import { expect, test } from 'vitest';
import { deviceProblem, listDevices } from './devices';

const err = (name: string) => new DOMException('x', name);
const info = (kind: MediaDeviceKind, deviceId: string, label = '') => ({ kind, deviceId, label }) as MediaDeviceInfo;

test('maps getUserMedia errors', () => {
  expect(deviceProblem(err('NotAllowedError'))).toBe('blocked');
  expect(deviceProblem(err('SecurityError'))).toBe('blocked');
  expect(deviceProblem(err('NotFoundError'))).toBe('missing');
  expect(deviceProblem(err('OverconstrainedError'))).toBe('missing');
  expect(deviceProblem(err('NotReadableError'))).toBe('busy');
  expect(deviceProblem(err('AbortError'))).toBe('busy');
  expect(deviceProblem(new Error('x'))).toBe('busy');
  expect(deviceProblem('x')).toBe('busy');
});

test('lists only the asked kind, keeping labels', () => {
  const infos = [
    info('audioinput', 'm1', 'Built-in mic'),
    info('videoinput', 'c1', 'FaceTime HD'),
    info('audiooutput', 's1', 'Speakers'),
  ];
  expect(listDevices(infos, 'videoinput')).toEqual([{ id: 'c1', label: 'FaceTime HD' }]);
  expect(listDevices(infos, 'audioinput')).toEqual([{ id: 'm1', label: 'Built-in mic' }]);
});

test('empty labels become numbered names, counting only that kind', () => {
  const infos = [info('audioinput', 'm1'), info('videoinput', 'c1'), info('videoinput', 'c2')];
  expect(listDevices(infos, 'videoinput')).toEqual([
    { id: 'c1', label: 'Camera 1' },
    { id: 'c2', label: 'Camera 2' },
  ]);
  expect(listDevices(infos, 'audioinput')).toEqual([{ id: 'm1', label: 'Microphone 1' }]);
});

test('drops entries with an empty deviceId', () => {
  expect(listDevices([info('videoinput', ''), info('videoinput', 'c1')], 'videoinput')).toEqual([
    { id: 'c1', label: 'Camera 1' },
  ]);
});
