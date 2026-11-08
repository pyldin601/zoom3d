// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DeviceProblem } from '../media/devices';
import type { LocalMediaController, MediaState } from '../media/local-media';
import { DEFAULT_MEDIA_PREFS, type MediaPrefs } from '../media/media-prefs';
import { joinBanner, type LobbyOptions, problemLine, showLobby } from './lobby';

let root: HTMLElement;
let dispose: (() => void) | null;

const STATE: MediaState = {
  cam: true,
  mic: true,
  camAvailable: true,
  micAvailable: true,
  camProblem: null,
  micProblem: null,
  pending: false,
};

function fakeMedia(state: Partial<MediaState> = {}, prefs: Partial<MediaPrefs> = {}) {
  let st: MediaState = { ...STATE, ...state };
  const pr: MediaPrefs = { ...DEFAULT_MEDIA_PREFS, ...prefs };
  const subscribers = new Set<() => void>();
  const notify = () => {
    for (const fn of subscribers) {
      fn();
    }
  };
  const media = {
    stream: {},
    framer: { track: { kind: 'video', id: 'canvas' } },
    ready: Promise.resolve(),
    state: () => st,
    prefs: () => pr,
    setCam: vi.fn(async (on: boolean) => {
      pr.cam = on;
      notify();
    }),
    setMic: vi.fn((on: boolean) => {
      pr.mic = on;
      notify();
    }),
    useCamera: vi.fn(async () => {}),
    useMic: vi.fn(async () => {}),
    devices: vi.fn(async () => ({
      cams: [
        { id: 'c1', label: 'FaceTime HD' },
        { id: 'c2', label: 'Camera 2' },
      ],
      mics: [{ id: 'm1', label: 'Built-in mic' }],
    })),
    micTrack: () => null,
    subscribe(fn: () => void) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
  const set = (next: Partial<MediaState>) => {
    st = { ...st, ...next };
    notify();
  };
  return { media, controller: media as unknown as LocalMediaController, set };
}

function show(opts: Partial<LobbyOptions> & { media?: LocalMediaController } = {}) {
  const lobby: LobbyOptions = {
    media: opts.media ?? fakeMedia().controller,
    defaultName: '',
    defaultAvatar: null,
    inviteUrl: 'http://x/r/AAAAAAAAAAAAAAAAAAAAAA',
    onJoin: () => {},
    ...opts,
  };
  dispose = showLobby(root, lobby);
}

beforeEach(() => {
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.getElementById('ui') as HTMLElement;
  dispose = null;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
});

afterEach(() => {
  dispose?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PIC = 'data:image/jpeg;base64,/9j/4AAQ';
const disc = () => root.querySelector('.lobby-disc') as HTMLElement;
const byLabel = (label: string) => root.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const button = (name: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;
const nameInput = () => root.querySelector('input[name="name"]') as HTMLInputElement;
const errorLine = () => root.querySelector('.error')?.textContent;
const flush = () => new Promise((r) => setTimeout(r, 0));
function submit(name: string) {
  nameInput().value = name;
  (root.querySelector('form') as HTMLFormElement).requestSubmit();
}
function pickFile(file: File) {
  const input = root.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}
const camOff = () => fakeMedia({ cam: false }, { cam: false }).controller;

test('a name with markup is passed through literally and never parsed', () => {
  const onJoin = vi.fn();
  show({ onJoin, media: camOff() });
  submit('<img src=x onerror=1>');
  expect(onJoin).toHaveBeenCalledWith('<img src=x onerror=1>', null);
  expect(root.querySelector('img')).toBeNull();
});

test('an empty name shows an error instead of joining', () => {
  const onJoin = vi.fn();
  show({ onJoin });
  submit('   ');
  expect(onJoin).not.toHaveBeenCalled();
  expect(errorLine()).toMatch(/name/i);
});

test('the default name is prefilled', () => {
  show({ defaultName: 'Ada' });
  expect(nameInput().value).toBe('Ada');
  expect(nameInput().placeholder).toBe('Your name');
});

test('with the camera on the disc shows the canvas preview and no pencil', () => {
  show({ defaultAvatar: PIC });
  const video = disc().querySelector('video') as HTMLVideoElement;
  expect(video.hidden).toBe(false);
  expect(video.muted).toBe(true);
  expect(disc().querySelector('img')).toBeNull();
  expect(byLabel('Change picture')?.hidden).toBe(true);
});

test('the pencil shows only while the camera is off', () => {
  const { controller, set } = fakeMedia();
  show({ media: controller });
  expect(byLabel('Change picture')?.hidden).toBe(true);
  set({ cam: false });
  expect(byLabel('Change picture')?.hidden).toBe(false);
  expect((disc().querySelector('video') as HTMLVideoElement).hidden).toBe(true);
  set({ cam: true });
  expect(byLabel('Change picture')?.hidden).toBe(true);
});

test('a camera still starting shows the preview, not the picture', () => {
  const { controller, set } = fakeMedia({ cam: false, pending: true }, { cam: true });
  show({ defaultAvatar: PIC, media: controller });
  const video = disc().querySelector('video') as HTMLVideoElement;
  expect(video.hidden).toBe(false);
  expect((disc().querySelector('.face') as HTMLElement).hidden).toBe(true);
  expect(byLabel('Change picture')?.hidden).toBe(true);
  // The request failed: back to the picture.
  set({ pending: false, camProblem: 'busy' });
  expect(video.hidden).toBe(true);
  expect(disc().querySelector('img')?.getAttribute('src')).toBe(PIC);
});

test('initials follow the typed name while the camera is off', () => {
  show({ defaultName: 'Ada Lovelace', media: camOff() });
  const face = () => disc().querySelector('.face')?.textContent;
  expect(face()).toBe('AL');
  nameInput().value = 'Bob';
  nameInput().dispatchEvent(new Event('input'));
  expect(face()).toBe('B');
});

test('Remove appears only with a picture, and clears it', () => {
  const onJoin = vi.fn();
  show({ defaultName: 'Ada', defaultAvatar: PIC, onJoin, media: camOff() });
  expect(disc().querySelector('img')?.getAttribute('src')).toBe(PIC);
  byLabel('Change picture')?.click();
  expect(button('Remove').hidden).toBe(false);
  button('Remove').click();
  expect(disc().querySelector('img')).toBeNull();
  byLabel('Change picture')?.click();
  expect(button('Remove').hidden).toBe(true);
  submit('Ada');
  expect(onJoin).toHaveBeenCalledWith('Ada', null);
});

test('Choose picture opens the file picker for images', () => {
  show({ media: camOff() });
  const input = root.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input.accept).toBe('image/*');
  const click = vi.spyOn(input, 'click');
  byLabel('Change picture')?.click();
  button('Choose picture…').click();
  expect(click).toHaveBeenCalled();
});

test('choosing a file encodes it into the disc and the join', async () => {
  const onJoin = vi.fn();
  const pickAvatar = vi.fn(async () => PIC);
  show({ defaultName: 'Ada', onJoin, pickAvatar, media: camOff() });
  const file = new File(['x'], 'me.png', { type: 'image/png' });
  pickFile(file);
  await flush();
  expect(pickAvatar).toHaveBeenCalledWith(file);
  expect(disc().querySelector('img')?.getAttribute('src')).toBe(PIC);
  submit('Ada');
  expect(onJoin).toHaveBeenCalledWith('Ada', PIC);
});

test('a too-detailed picture shows its error and keeps the previous one', async () => {
  const pickAvatar = vi.fn(async () => {
    throw new Error('too_big');
  });
  show({ defaultAvatar: PIC, pickAvatar, media: camOff() });
  pickFile(new File(['x'], 'huge.jpg'));
  await flush();
  expect(errorLine()).toBe('That picture is too detailed — try another');
  expect(disc().querySelector('img')?.getAttribute('src')).toBe(PIC);
});

test('an unreadable picture shows a generic error', async () => {
  const pickAvatar = vi.fn(async () => {
    throw new Error('unreadable');
  });
  show({ pickAvatar, media: camOff() });
  pickFile(new File(['%PDF'], 'doc.jpg'));
  await flush();
  expect(errorLine()).toMatch(/couldn.t read that picture/i);
  expect(button('Join').disabled).toBe(false);
});

test('a slower earlier pick never overwrites a later one, and Join waits for encoding', async () => {
  const onJoin = vi.fn();
  const resolvers: ((url: string) => void)[] = [];
  const pickAvatar = vi.fn(() => new Promise<string>((r) => resolvers.push(r)));
  show({ defaultName: 'Ada', onJoin, pickAvatar, media: camOff() });
  pickFile(new File(['1'], 'big.jpg'));
  pickFile(new File(['2'], 'small.jpg'));
  expect(button('Join').disabled).toBe(true);
  submit('Ada');
  expect(onJoin).not.toHaveBeenCalled();
  resolvers[1]?.(`${PIC}B`);
  await flush();
  resolvers[0]?.(`${PIC}A`);
  await flush();
  expect(disc().querySelector('img')?.getAttribute('src')).toBe(`${PIC}B`);
  expect(button('Join').disabled).toBe(false);
  submit('Ada');
  expect(onJoin).toHaveBeenCalledWith('Ada', `${PIC}B`);
});

test('Join is disabled while media is pending', () => {
  const onJoin = vi.fn();
  const { controller, set } = fakeMedia({ pending: true });
  show({ defaultName: 'Ada', onJoin, media: controller });
  expect(button('Join').disabled).toBe(true);
  submit('Ada');
  expect(onJoin).not.toHaveBeenCalled();
  set({ pending: false });
  expect(button('Join').disabled).toBe(false);
  submit('Ada');
  expect(onJoin).toHaveBeenCalledOnce();
});

test('camera toggle calls setCam with the opposite state and is labelled for the next action', () => {
  const { media, controller, set } = fakeMedia();
  show({ media: controller });
  byLabel('Turn camera off')?.click();
  expect(media.setCam).toHaveBeenCalledWith(false);
  set({ cam: false });
  expect(byLabel('Turn camera off')).toBeNull();
  byLabel('Turn camera on')?.click();
  expect(media.setCam).toHaveBeenLastCalledWith(true);
});

test('a second click while the camera is still starting turns it back off', () => {
  const { media, controller } = fakeMedia({ cam: false, pending: true }, { cam: false });
  show({ media: controller });
  byLabel('Turn camera on')?.click();
  // getUserMedia hasn't resolved: no live camera yet, but the toggle follows what was asked.
  byLabel('Turn camera off')?.click();
  expect(media.setCam.mock.calls).toEqual([[true], [false]]);
});

test('a busy camera shows as off and a click retries it', () => {
  const { media, controller } = fakeMedia({ cam: false, camProblem: 'busy' }, { cam: true });
  show({ media: controller });
  byLabel('Turn camera on')?.click();
  expect(media.setCam).toHaveBeenCalledWith(true);
});

test('a mic still starting shows as on, so it can be muted before it arrives', () => {
  const { media, controller } = fakeMedia({ mic: false, pending: true }, { mic: true });
  show({ media: controller });
  byLabel('Mute microphone')?.click();
  expect(media.setMic).toHaveBeenCalledWith(false);
});

test('a quick restart shows no waiting line; one that stalls (a permission prompt) does', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { controller, set } = fakeMedia({ pending: true });
  show({ media: controller });
  expect(errorLine()).toBe('');
  vi.advanceTimersByTime(999);
  expect(errorLine()).toBe('');
  vi.advanceTimersByTime(1);
  expect(errorLine()).toBe('Waiting for the camera and mic: check the browser’s permission prompt.');
  set({ pending: false });
  expect(errorLine()).toBe('');
  set({ pending: true });
  vi.advanceTimersByTime(500);
  set({ pending: false });
  vi.advanceTimersByTime(1000);
  expect(errorLine()).toBe('');
  vi.useRealTimers();
});

test('a click outside closes an open menu; a click inside it does not', async () => {
  show({ defaultAvatar: PIC, media: camOff() });
  const press = (target: Element) => target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  const pictureMenu = root.querySelector('.picture-menu') as HTMLElement;
  byLabel('Change picture')?.click();
  expect(pictureMenu.hidden).toBe(false);
  press(button('Remove'));
  expect(pictureMenu.hidden).toBe(false);
  press(nameInput());
  expect(pictureMenu.hidden).toBe(true);

  byLabel('Choose camera')?.click();
  await flush();
  const cameraMenu = root.querySelector('[data-device="cam"] .device-menu') as HTMLElement;
  expect(cameraMenu.hidden).toBe(false);
  press(document.body);
  expect(cameraMenu.hidden).toBe(true);
});

test('the button that opened a menu still toggles it closed', async () => {
  show();
  const chevron = byLabel('Choose camera') as HTMLButtonElement;
  chevron.click();
  await flush();
  const cameraMenu = root.querySelector('[data-device="cam"] .device-menu') as HTMLElement;
  chevron.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  chevron.click();
  expect(cameraMenu.hidden).toBe(true);
});

test('mic toggle mutes and unmutes', () => {
  const { media, controller, set } = fakeMedia();
  show({ media: controller });
  byLabel('Mute microphone')?.click();
  expect(media.setMic).toHaveBeenCalledWith(false);
  set({ mic: false });
  byLabel('Unmute microphone')?.click();
  expect(media.setMic).toHaveBeenLastCalledWith(true);
});

test('device menus list devices and mark the one in use; choosing one switches to it', async () => {
  const { media, controller } = fakeMedia({}, { camId: 'c2' });
  show({ media: controller });
  byLabel('Choose camera')?.click();
  await flush();
  const items = [...root.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[];
  expect(items.map((i) => i.textContent)).toEqual(['FaceTime HD', 'Camera 2']);
  expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  items[0]?.click();
  expect(media.useCamera).toHaveBeenCalledWith('c1');
  expect(root.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);

  byLabel('Choose microphone')?.click();
  await flush();
  const mics = [...root.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[];
  expect(mics.map((i) => i.getAttribute('aria-checked'))).toEqual(['true']);
  mics[0]?.click();
  expect(media.useMic).toHaveBeenCalledWith('m1');
});

const PROBLEMS: [Partial<MediaState>, string][] = [
  [
    {
      cam: false,
      mic: false,
      camAvailable: false,
      micAvailable: false,
      camProblem: 'insecure',
      micProblem: 'insecure',
    },
    'Camera and mic need HTTPS.',
  ],
  [{ cam: false, camAvailable: false, camProblem: 'blocked' }, 'Camera blocked: allow it in the address bar.'],
  [
    { mic: false, micAvailable: false, micProblem: 'blocked' },
    'Microphone blocked: allow it in the address bar. You can still listen.',
  ],
  [{ cam: false, camAvailable: false, camProblem: 'missing' }, 'No camera found.'],
  [{ mic: false, micAvailable: false, micProblem: 'missing' }, 'No microphone found.'],
  [{ cam: false, camProblem: 'busy' }, 'Camera is in use by another app.'],
  [{ mic: false, micProblem: 'busy' }, 'Microphone is in use by another app.'],
];

test.each(PROBLEMS)('problem %o shows its line', (state, text) => {
  expect(problemLine({ ...STATE, ...state })).toBe(text);
  show({ media: fakeMedia(state).controller });
  expect(errorLine()).toBe(text);
});

test('an unavailable device disables its toggle and menu', () => {
  show({ media: fakeMedia({ cam: false, camAvailable: false, camProblem: 'blocked' as DeviceProblem }).controller });
  expect(byLabel('Turn camera on')?.disabled).toBe(true);
  expect(byLabel('Choose camera')?.disabled).toBe(true);
  expect(byLabel('Mute microphone')?.disabled).toBe(false);
});

test('the mic meter fills the mic icon with the level; there is no ring', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame'] });
  const { controller, set } = fakeMedia();
  show({ media: controller, level: () => 0.5 });
  vi.advanceTimersToNextFrame();
  const meter = () => byLabel('Mute microphone')?.querySelector('.meter');
  expect(meter()?.getAttribute('height')).toBe('6');
  expect(meter()?.getAttribute('y')).toBe('8');
  expect(disc().style.boxShadow).toBe('');
  // A re-render redraws the icon; the meter keeps its level without waiting for a frame.
  nameInput().dispatchEvent(new Event('input'));
  expect(meter()?.getAttribute('height')).toBe('6');
  set({ mic: false });
  vi.advanceTimersToNextFrame();
  expect(meter()?.getAttribute('height')).toBe('0');
  vi.useRealTimers();
});

test('a muted mic shows no meter', () => {
  const { controller } = fakeMedia({ mic: false }, { mic: false });
  show({ media: controller, level: () => 0.5 });
  expect(byLabel('Unmute microphone')?.querySelector('.meter')).toBeNull();
  expect(byLabel('Turn camera off')?.querySelector('.meter')).toBeNull();
});

test('dispose stops the preview and unsubscribes', () => {
  const { controller, set } = fakeMedia();
  show({ media: controller });
  const video = disc().querySelector('video') as HTMLVideoElement;
  dispose?.();
  dispose = null;
  expect(video.srcObject).toBeNull();
  set({ cam: false });
  expect(byLabel('Change picture')?.hidden).toBe(true);
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: spy }, configurable: true });
  return spy;
}

test('under Join, after a divider, a button copies the invite link and says Copied for 2 s', async () => {
  const writeText = stubClipboard(() => Promise.resolve());
  const onJoin = vi.fn();
  show({ onJoin });
  const copy = button('Copy invite link');
  expect(copy.type).toBe('button');
  expect(copy.closest('form')).toBeNull();
  expect(copy.closest('.invite')?.previousElementSibling).toBe(root.querySelector('.error'));
  expect(copy.querySelector('svg')).not.toBeNull();
  vi.useFakeTimers();
  copy.click();
  expect(writeText).toHaveBeenCalledWith('http://x/r/AAAAAAAAAAAAAAAAAAAAAA');
  expect(onJoin).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(copy.textContent).toBe('Copied');
  await vi.advanceTimersByTimeAsync(2000);
  expect(copy.textContent).toBe('Copy invite link');
  expect(copy.querySelector('svg')).not.toBeNull();
});

test('a copy that fails points to the address bar', async () => {
  stubClipboard(() => Promise.reject(new Error('denied')));
  show();
  button('Copy invite link').click();
  await flush();
  expect(errorLine()).toBe("Couldn't copy the link. It's in the address bar.");
});

test('joinBanner explains devices unavailable at Join', () => {
  const off = { cam: false, mic: false };
  expect(
    joinBanner({
      ...STATE,
      ...off,
      camAvailable: false,
      micAvailable: false,
      camProblem: 'insecure',
      micProblem: 'insecure',
    })
  ).toBe('Camera and mic need HTTPS — joined without them.');
  expect(joinBanner({ ...STATE, cam: false, camAvailable: false, camProblem: 'blocked' })).toBe(
    'Camera unavailable — others see your picture or initials.'
  );
  expect(joinBanner({ ...STATE, mic: false, micAvailable: false, micProblem: 'missing' })).toBe(
    'Microphone unavailable — you can listen only.'
  );
  expect(
    joinBanner({
      ...STATE,
      ...off,
      camAvailable: false,
      micAvailable: false,
      camProblem: 'missing',
      micProblem: 'blocked',
    })
  ).toBe('Camera and mic unavailable — others see your picture or initials, you can listen only.');
  expect(joinBanner({ ...STATE, cam: false })).toBeNull();
});

const press = (key: string) => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
};
const cameraChevron = () => byLabel('Choose camera') as HTMLButtonElement;
const cameraMenu = () => root.querySelector('[data-device="cam"] .device-menu') as HTMLElement;
const focusedText = () => document.activeElement?.textContent;
async function openCameraMenu() {
  cameraChevron().click();
  await flush();
}

test('the name field is named for screen readers, which skip a placeholder', () => {
  show();
  expect(nameInput().getAttribute('aria-label')).toBe('Your name');
});

test('errors are announced as they appear', () => {
  show();
  expect(root.querySelector('.error')?.getAttribute('role')).toBe('alert');
});

test('typing does not rewrite an unchanged error, which would announce it again', () => {
  show({ media: fakeMedia({ mic: false, micProblem: 'blocked' }).controller });
  const text = root.querySelector('.error')?.firstChild;
  expect(text).toBeTruthy();
  nameInput().value = 'Ada';
  nameInput().dispatchEvent(new Event('input'));
  expect(root.querySelector('.error')?.firstChild).toBe(text);
});

test('a device menu takes focus on the device in use', async () => {
  show({ media: fakeMedia({}, { camId: 'c2' }).controller });
  await openCameraMenu();
  expect(focusedText()).toBe('Camera 2');
});

test('with no device chosen, a device menu takes focus on the first', async () => {
  show();
  await openCameraMenu();
  expect(focusedText()).toBe('FaceTime HD');
});

test('arrow keys, Home and End move through a device menu, wrapping at its ends', async () => {
  show();
  await openCameraMenu();
  press('ArrowDown');
  expect(focusedText()).toBe('Camera 2');
  press('ArrowDown');
  expect(focusedText()).toBe('FaceTime HD');
  press('ArrowUp');
  expect(focusedText()).toBe('Camera 2');
  press('Home');
  expect(focusedText()).toBe('FaceTime HD');
  press('End');
  expect(focusedText()).toBe('Camera 2');
});

test('arrow keys in a device menu do not scroll the page', async () => {
  show();
  await openCameraMenu();
  const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  document.activeElement?.dispatchEvent(arrow);
  expect(arrow.defaultPrevented).toBe(true);
});

test('menu items are reached with the arrow keys, so Tab leaves the menu', async () => {
  show();
  await openCameraMenu();
  const items = [...cameraMenu().querySelectorAll('button')];
  expect(items.map((i) => i.tabIndex)).toEqual([-1, -1]);
});

test.each(['Escape', 'Tab'])('%s closes a device menu and hands focus back to its button', async (key) => {
  show();
  await openCameraMenu();
  press(key);
  expect(cameraMenu().hidden).toBe(true);
  expect(document.activeElement).toBe(cameraChevron());
});

test('choosing a device hands focus back to the menu button', async () => {
  show();
  await openCameraMenu();
  (document.activeElement as HTMLButtonElement).click();
  expect(document.activeElement).toBe(cameraChevron());
});

test('Escape closes the picture menu and hands focus back to the pencil', () => {
  show({ defaultAvatar: PIC, media: camOff() });
  const pencil = byLabel('Change picture') as HTMLButtonElement;
  pencil.click();
  button('Remove').focus();
  press('Escape');
  expect((root.querySelector('.picture-menu') as HTMLElement).hidden).toBe(true);
  expect(document.activeElement).toBe(pencil);
});

test('Escape with every menu closed leaves focus where it is', () => {
  show();
  nameInput().focus();
  press('Escape');
  expect(document.activeElement).toBe(nameInput());
});

test('a device menu button says whether its menu is open, however it closes', async () => {
  show();
  const expanded = () => cameraChevron().getAttribute('aria-expanded');
  expect(expanded()).toBe('false');
  await openCameraMenu();
  expect(expanded()).toBe('true');
  cameraChevron().click();
  expect(expanded()).toBe('false');

  await openCameraMenu();
  press('Escape');
  expect(expanded()).toBe('false');

  await openCameraMenu();
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(expanded()).toBe('false');

  await openCameraMenu();
  byLabel('Choose microphone')?.click();
  await flush();
  expect(expanded()).toBe('false');

  await openCameraMenu();
  (document.activeElement as HTMLButtonElement).click();
  expect(expanded()).toBe('false');
});

test('the pencil says whether the picture menu is open, however it closes', () => {
  const { controller, set } = fakeMedia({ cam: false }, { cam: false });
  show({ defaultAvatar: PIC, media: controller });
  const pencil = byLabel('Change picture') as HTMLButtonElement;
  const expanded = () => pencil.getAttribute('aria-expanded');
  expect(expanded()).toBe('false');
  pencil.click();
  expect(expanded()).toBe('true');
  button('Remove').click();
  expect(expanded()).toBe('false');

  pencil.click();
  expect(expanded()).toBe('true');
  set({ cam: true });
  expect(expanded()).toBe('false');
});

test('after the lobby goes, Escape no longer reaches its menus', () => {
  show({ defaultAvatar: PIC, media: camOff() });
  (byLabel('Change picture') as HTMLButtonElement).click();
  const picture = root.querySelector('.picture-menu') as HTMLElement;
  dispose?.();
  dispose = null;
  press('Escape');
  expect(picture.hidden).toBe(false);
});
