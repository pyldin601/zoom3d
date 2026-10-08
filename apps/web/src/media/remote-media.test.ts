// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { createRemoteMedia } from './remote-media';

test('remote elements play muted: their audio is owned by the spatial engine', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const stream = new MediaStream();
  const el = createRemoteMedia(container).attach('b', stream);
  expect(el.muted).toBe(true);
  expect(el.autoplay).toBe(true);
  expect(el.playsInline).toBe(true);
  expect(el.srcObject).toBe(stream);
  expect(container.contains(el)).toBe(true);
});
