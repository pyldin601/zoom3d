// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clearScreen, showBanner, showLanding, showNotice, showRoomBar, showSelfPreview, showStatus } from './screens';

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.getElementById('ui') as HTMLElement;
});

test('landing calls onCreate', () => {
  const onCreate = vi.fn();
  showLanding(root, onCreate);
  (root.querySelector('button') as HTMLButtonElement).click();
  expect(onCreate).toHaveBeenCalledOnce();
});

test('status overlay shows and clears independently of the screen', () => {
  showLanding(root, () => {});
  showStatus(root, 'Reconnecting…');
  expect(root.querySelector('.status')?.textContent).toBe('Reconnecting…');
  showStatus(root, null);
  expect(root.querySelector('.status')).toBeNull();
  expect(root.querySelector('.screen')).not.toBeNull();
  clearScreen(root);
  expect(root.querySelector('.screen')).toBeNull();
});

test('notice screen shows text and a link', () => {
  showNotice(root, 'Bad room link', 'Start a new room', '/');
  expect(root.textContent).toContain('Bad room link');
  expect(root.querySelector('a')?.getAttribute('href')).toBe('/');
});

test('room bar copies the invite link', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  showRoomBar(root, 'http://x/r/AAAAAAAAAAAAAAAAAAAAAA');
  (root.querySelector('.roombar button') as HTMLButtonElement).click();
  expect(writeText).toHaveBeenCalledWith('http://x/r/AAAAAAAAAAAAAAAAAAAAAA');
});

test('room bar mic/cam toggles flip aria-pressed and call handlers', () => {
  const onCam = vi.fn(async (on: boolean) => on);
  const onMic = vi.fn((on: boolean) => on);
  showRoomBar(root, 'http://x', {
    cam: true,
    mic: true,
    camAvailable: true,
    micAvailable: true,
    onCam,
    onMic,
  });
  const mic = root.querySelector('button[data-control="mic"]') as HTMLButtonElement;
  expect(mic.getAttribute('aria-pressed')).toBe('true');
  mic.click();
  expect(onMic).toHaveBeenCalledWith(false);
  expect(mic.getAttribute('aria-pressed')).toBe('false');
  expect(mic.getAttribute('aria-label')).toBe('Mic off');
  expect(mic.textContent).toBe('');
  expect(mic.classList.contains('off')).toBe(true);
  expect(mic.querySelectorAll('svg path')).toHaveLength(4); // the lobby's mic icon plus its slash
  mic.click();
  expect(onMic).toHaveBeenLastCalledWith(true);
});

test('unavailable devices disable their toggle', () => {
  showRoomBar(root, 'http://x', {
    cam: false,
    mic: true,
    camAvailable: false,
    micAvailable: true,
    onCam: async () => false,
    onMic: () => true,
  });
  const cam = root.querySelector('button[data-control="cam"]') as HTMLButtonElement;
  expect(cam.disabled).toBe(true);
  expect(cam.getAttribute('aria-label')).toBe('No cam');
});

test('a cam toggle whose handler resolves false goes back to Cam off', async () => {
  let resolve: (on: boolean) => void = () => {};
  showRoomBar(root, 'http://x', {
    cam: false,
    mic: true,
    camAvailable: true,
    micAvailable: true,
    onCam: () => new Promise<boolean>((r) => (resolve = r)),
    onMic: (on) => on,
  });
  const cam = root.querySelector('button[data-control="cam"]') as HTMLButtonElement;
  cam.click();
  expect(cam.getAttribute('aria-label')).toBe('Cam on');
  resolve(false);
  await new Promise((r) => setTimeout(r, 0));
  expect(cam.getAttribute('aria-label')).toBe('Cam off');
  expect(cam.getAttribute('aria-pressed')).toBe('false');
});

afterEach(() => vi.useRealTimers());

test('banners show text literally and hide after 8 s', () => {
  vi.useFakeTimers();
  showBanner(root, '<b>Camera unavailable</b>');
  expect(root.querySelector('.banner')?.textContent).toBe('<b>Camera unavailable</b>');
  expect(root.querySelector('b')).toBeNull();
  vi.advanceTimersByTime(8000);
  expect(root.querySelector('.banner')).toBeNull();
});

test('self preview shows a muted mirrored video while the camera is on', () => {
  const stream = new MediaStream();
  showSelfPreview(root, stream, { cam: true, name: 'Ada Lovelace', avatar: null });
  const box = root.querySelector('.selfview') as HTMLElement;
  const video = box.querySelector('video') as HTMLVideoElement;
  expect(box.hidden).toBe(false);
  expect(video.muted).toBe(true);
  expect(video.srcObject).toBe(stream);
  expect(video.hidden).toBe(false);
  expect((box.querySelector('.face') as HTMLElement).hidden).toBe(true);
});

test('with the camera off the self preview shows your picture, else your initials', () => {
  const stream = new MediaStream();
  const PIC = 'data:image/jpeg;base64,/9j/4AAQ';
  showSelfPreview(root, stream, { cam: false, name: 'Ada Lovelace', avatar: PIC });
  const box = root.querySelector('.selfview') as HTMLElement;
  const face = box.querySelector('.face') as HTMLElement;
  expect(box.hidden).toBe(false);
  expect((box.querySelector('video') as HTMLVideoElement).hidden).toBe(true);
  expect(face.hidden).toBe(false);
  expect(face.querySelector('img')?.getAttribute('src')).toBe(PIC);

  showSelfPreview(root, stream, { cam: false, name: '<b>Ada</b> Lovelace', avatar: null });
  expect(face.querySelector('img')).toBeNull();
  expect(face.querySelector('b')).toBeNull();
  expect(face.textContent).toBe('<L');
});
