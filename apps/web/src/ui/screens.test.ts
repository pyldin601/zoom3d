// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  clearScreen,
  type MediaControls,
  showBanner,
  showLanding,
  showMediaControls,
  showNotice,
  showPeopleCount,
  showSelfPreview,
  showStatus,
} from './screens';

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.getElementById('ui') as HTMLElement;
});

test('landing is a lobby-styled panel whose primary button calls onCreate', () => {
  const onCreate = vi.fn();
  showLanding(root, onCreate);
  const panel = root.querySelector('.screen .lobby.landing') as HTMLElement;
  expect(panel.querySelector('h1')?.textContent).toBe('zoom3d');
  expect(panel.querySelector('p')?.textContent).toBe('Beer with your buddies in raycaster.');
  const create = panel.querySelector('button.primary') as HTMLButtonElement;
  expect(create.textContent).toBe('Start a party');
  create.click();
  expect(onCreate).toHaveBeenCalledOnce();
  expect(panel.querySelector('a.privacy')?.getAttribute('href')).toBe('/privacy.html');
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

test('the people count shows the number with a spelled-out title, and null removes it', () => {
  showPeopleCount(root, 1);
  const count = root.querySelector('.people') as HTMLElement;
  expect(count.textContent).toBe('1');
  expect(count.title).toBe('1 person in the room');
  expect(count.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  showPeopleCount(root, 5);
  expect(root.querySelectorAll('.people')).toHaveLength(1);
  expect(count.textContent).toBe('5');
  expect(count.title).toBe('5 people in the room');
  showPeopleCount(root, null);
  expect(root.querySelector('.people')).toBeNull();
});

test('notice screen shows text and a link', () => {
  showNotice(root, 'Bad room link', 'Start a new room', '/');
  expect(root.textContent).toContain('Bad room link');
  expect(root.querySelector('a')?.getAttribute('href')).toBe('/');
});

const controls = (over: Partial<MediaControls> = {}): MediaControls => ({
  cam: true,
  mic: true,
  camAvailable: true,
  micAvailable: true,
  onCam: async (on) => on,
  onMic: (on) => on,
  ...over,
});

test('the round mic button flips aria-pressed and calls its handler', () => {
  const onMic = vi.fn((on: boolean) => on);
  showMediaControls(root, controls({ onMic }));
  const mic = root.querySelector(':scope > button.mic-toggle[data-control="mic"]') as HTMLButtonElement;
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

test('your own circle is the camera toggle and keeps showing your face', () => {
  const onCam = vi.fn(async (on: boolean) => on);
  showMediaControls(root, controls({ onCam }));
  showSelfPreview(root, new MediaStream(), { cam: true, name: 'Ada Lovelace', avatar: null });
  const cam = root.querySelector(':scope > button.selfview[data-control="cam"]') as HTMLButtonElement;
  expect(cam.getAttribute('aria-label')).toBe('Cam on');
  expect(cam.querySelectorAll('.hint svg path')).toHaveLength(3); // the hint offers to turn it off
  cam.click();
  expect(onCam).toHaveBeenCalledWith(false);
  expect(cam.getAttribute('aria-label')).toBe('Cam off');
  expect(cam.classList.contains('off')).toBe(true);
  expect(cam.querySelectorAll('.hint svg path')).toHaveLength(2); // the hint offers the camera back
  expect(cam.querySelector('video')).not.toBeNull();
});

test('unavailable devices disable their toggle', () => {
  showMediaControls(root, controls({ cam: false, camAvailable: false, micAvailable: false }));
  const cam = root.querySelector('button[data-control="cam"]') as HTMLButtonElement;
  expect(cam.disabled).toBe(true);
  expect(cam.getAttribute('aria-label')).toBe('No cam');
  expect((root.querySelector('button[data-control="mic"]') as HTMLButtonElement).disabled).toBe(true);
});

test('a cam toggle whose handler resolves false goes back to Cam off', async () => {
  let resolve: (on: boolean) => void = () => {};
  showMediaControls(root, controls({ cam: false, onCam: () => new Promise<boolean>((r) => (resolve = r)) }));
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
