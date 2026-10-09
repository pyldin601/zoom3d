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

test('boombox audio plays in a muted <audio>, not a <video>, and detaches by key', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const stream = new MediaStream();
  const remote = createRemoteMedia(container);
  remote.attachAudio('boombox:b', stream);
  const el = container.querySelector('audio') as HTMLAudioElement;
  expect(el.muted).toBe(true);
  expect(el.srcObject).toBe(stream);
  expect(container.querySelectorAll('video')).toHaveLength(0);
  remote.detach('boombox:b');
  expect(container.querySelector('audio')).toBeNull();
});
