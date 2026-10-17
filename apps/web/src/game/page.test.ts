import { expect, test } from 'vitest';
import { readPageFlags } from './page';

const none = () => false;

test('a plain page load: lights on, no pixel-perfect, desktop, motion allowed', () => {
  expect(readPageFlags('', none)).toEqual({ pixelPerfect: false, lights: true, touch: false, reducedMotion: false });
});

test('the URL turns lights off and pixel-perfect on', () => {
  expect(readPageFlags('?lights=off&pixelperfect', none)).toMatchObject({ pixelPerfect: true, lights: false });
});

test('the device says touch and reduced motion', () => {
  const flags = readPageFlags('', (query) => query === '(pointer: coarse)' || query.includes('reduced-motion'));
  expect(flags).toMatchObject({ touch: true, reducedMotion: true });
});
