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

test('the mic ring follows the level and is gone while muted', async () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame'] });
  const { controller, set } = fakeMedia();
  show({ media: controller, level: () => 0.5 });
  vi.advanceTimersToNextFrame();
  expect(disc().style.boxShadow).toContain('3px');
  set({ mic: false });
  vi.advanceTimersToNextFrame();
  expect(disc().style.boxShadow).toBe('none');
  vi.useRealTimers();
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
