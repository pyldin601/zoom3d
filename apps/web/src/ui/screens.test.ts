// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  clearScreen,
  showBanner,
  showJoin,
  showLanding,
  showNotice,
  showRoomBar,
  showSelfPreview,
  showStatus,
} from './screens';

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.getElementById('ui') as HTMLElement;
});

function submit(name: string) {
  const input = root.querySelector('input[name="name"]') as HTMLInputElement;
  input.value = name;
  (root.querySelector('form') as HTMLFormElement).requestSubmit();
}

test('landing calls onCreate', () => {
  const onCreate = vi.fn();
  showLanding(root, onCreate);
  (root.querySelector('button') as HTMLButtonElement).click();
  expect(onCreate).toHaveBeenCalledOnce();
});

test('a name with markup is passed through literally and never parsed', () => {
  const onJoin = vi.fn();
  showJoin(root, { defaultName: '', onJoin });
  submit('<img src=x onerror=1>');
  expect(onJoin).toHaveBeenCalledWith('<img src=x onerror=1>', null);
  expect(root.querySelector('img')).toBeNull();
});

test('an empty name shows an error instead of joining', () => {
  const onJoin = vi.fn();
  showJoin(root, { defaultName: '', onJoin });
  submit('   ');
  expect(onJoin).not.toHaveBeenCalled();
  expect(root.querySelector('.error')?.textContent).toMatch(/name/i);
});

test('the default name is prefilled and an error message is shown as text', () => {
  showJoin(root, { defaultName: 'Ada', error: '<b>full</b>', onJoin: () => {} });
  expect((root.querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Ada');
  expect(root.querySelector('b')).toBeNull();
  expect(root.querySelector('.error')?.textContent).toBe('<b>full</b>');
});

const PIC = 'data:image/jpeg;base64,/9j/4AAQ';
const preview = () => root.querySelector('.avatar') as HTMLElement;
const button = (name: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;
function pickFile(file: File) {
  const input = root.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('without a picture the preview shows the initials of the typed name', () => {
  showJoin(root, { defaultName: 'Ada Lovelace', onJoin: () => {} });
  expect(preview().querySelector('img')).toBeNull();
  expect(preview().textContent).toBe('AL');
  const input = root.querySelector('input[name="name"]') as HTMLInputElement;
  input.value = 'Bob';
  input.dispatchEvent(new Event('input'));
  expect(preview().textContent).toBe('B');
  expect(button('Remove').hidden).toBe(true);
});

test('a stored picture is previewed and sent with the join; Remove clears it', () => {
  const onJoin = vi.fn();
  showJoin(root, { defaultName: 'Ada', defaultAvatar: PIC, onJoin });
  expect(preview().querySelector('img')?.getAttribute('src')).toBe(PIC);
  submit('Ada');
  expect(onJoin).toHaveBeenLastCalledWith('Ada', PIC);
  button('Remove').click();
  expect(preview().querySelector('img')).toBeNull();
  submit('Ada');
  expect(onJoin).toHaveBeenLastCalledWith('Ada', null);
});

test('choosing a file encodes it into the preview', async () => {
  const onJoin = vi.fn();
  const pickAvatar = vi.fn(async () => PIC);
  showJoin(root, { defaultName: 'Ada', onJoin, pickAvatar });
  const file = new File(['x'], 'me.png', { type: 'image/png' });
  pickFile(file);
  await flush();
  expect(pickAvatar).toHaveBeenCalledWith(file);
  expect(preview().querySelector('img')?.getAttribute('src')).toBe(PIC);
  expect(button('Remove').hidden).toBe(false);
  submit('Ada');
  expect(onJoin).toHaveBeenCalledWith('Ada', PIC);
});

test('an unreadable file shows an error and keeps the previous picture', async () => {
  const pickAvatar = vi.fn(async () => {
    throw new Error('unreadable');
  });
  showJoin(root, { defaultName: 'Ada', defaultAvatar: PIC, onJoin: () => {}, pickAvatar });
  pickFile(new File(['%PDF'], 'doc.jpg'));
  await flush();
  expect(root.querySelector('.error')?.textContent).toMatch(/couldn.t read that picture/i);
  expect(preview().querySelector('img')?.getAttribute('src')).toBe(PIC);
});

test('a slower earlier pick never overwrites a later one, and Join waits for encoding', async () => {
  const onJoin = vi.fn();
  const resolvers: ((url: string) => void)[] = [];
  const pickAvatar = vi.fn(() => new Promise<string>((r) => resolvers.push(r)));
  showJoin(root, { defaultName: 'Ada', onJoin, pickAvatar });
  pickFile(new File(['1'], 'big.jpg'));
  pickFile(new File(['2'], 'small.jpg'));
  const join = button('Join');
  expect(join.disabled).toBe(true);
  submit('Ada');
  expect(onJoin).not.toHaveBeenCalled();
  resolvers[1]?.(`${PIC}B`);
  await flush();
  resolvers[0]?.(`${PIC}A`);
  await flush();
  expect(preview().querySelector('img')?.getAttribute('src')).toBe(`${PIC}B`);
  expect(join.disabled).toBe(false);
  submit('Ada');
  expect(onJoin).toHaveBeenCalledWith('Ada', `${PIC}B`);
});

test('Join is re-enabled when encoding fails', async () => {
  const pickAvatar = vi.fn(async () => {
    throw new Error('unreadable');
  });
  showJoin(root, { defaultName: 'Ada', onJoin: () => {}, pickAvatar });
  pickFile(new File(['x'], 'x.jpg'));
  await flush();
  expect(button('Join').disabled).toBe(false);
});

test('Choose picture opens the file picker for images', () => {
  showJoin(root, { defaultName: '', onJoin: () => {} });
  const input = root.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input.accept).toBe('image/*');
  const click = vi.spyOn(input, 'click');
  button('Choose picture…').click();
  expect(click).toHaveBeenCalled();
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
  const onCam = vi.fn();
  const onMic = vi.fn();
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
  expect(mic.textContent).toBe('Mic off');
  mic.click();
  expect(onMic).toHaveBeenLastCalledWith(true);
});

test('unavailable devices disable their toggle', () => {
  showRoomBar(root, 'http://x', {
    cam: false,
    mic: true,
    camAvailable: false,
    micAvailable: true,
    onCam: () => {},
    onMic: () => {},
  });
  expect((root.querySelector('button[data-control="cam"]') as HTMLButtonElement).disabled).toBe(true);
});

test('room bar held picker shows the current item and reports changes', () => {
  const onHeld = vi.fn();
  showRoomBar(root, 'http://x', undefined, { held: 'coffee', onHeld });
  const select = root.querySelector('select[data-control="held"]') as HTMLSelectElement;
  expect(select.getAttribute('aria-label')).toBe('In hand');
  expect(select.value).toBe('coffee');
  expect([...select.options].map((o) => o.textContent)).toEqual(['Nothing in hand', 'Beer', 'Coffee', 'Wine']);
  select.value = 'wine';
  select.dispatchEvent(new Event('change'));
  expect(onHeld).toHaveBeenLastCalledWith('wine');
  select.value = '';
  select.dispatchEvent(new Event('change'));
  expect(onHeld).toHaveBeenLastCalledWith(null);
});

test('the held picker gives up focus after a change', () => {
  showRoomBar(root, 'http://x', undefined, { held: null, onHeld: () => {} });
  const select = root.querySelector('select[data-control="held"]') as HTMLSelectElement;
  select.focus();
  expect(document.activeElement).toBe(select);
  select.value = 'beer';
  select.dispatchEvent(new Event('change'));
  expect(document.activeElement).not.toBe(select);
});

test('a letter key on the focused held picker leaves it instead of picking by typeahead', () => {
  const onHeld = vi.fn();
  showRoomBar(root, 'http://x', undefined, { held: null, onHeld });
  const select = root.querySelector('select[data-control="held"]') as HTMLSelectElement;
  select.focus();
  const w = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true });
  select.dispatchEvent(w);
  expect(w.defaultPrevented).toBe(true);
  expect(document.activeElement).not.toBe(select);
  expect(onHeld).not.toHaveBeenCalled();
  select.focus();
  const down = new KeyboardEvent('keydown', { code: 'ArrowDown', key: 'ArrowDown', bubbles: true, cancelable: true });
  select.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(select);
});

test('the room bar returns a setter that moves the held picker without reporting a change', () => {
  const onHeld = vi.fn();
  const setHeld = showRoomBar(root, 'http://x', undefined, { held: null, onHeld });
  const select = root.querySelector('select[data-control="held"]') as HTMLSelectElement;
  setHeld('wine');
  expect(select.value).toBe('wine');
  setHeld(null);
  expect(select.value).toBe('');
  expect(onHeld).not.toHaveBeenCalled();
});

test('no held control renders no picker', () => {
  showRoomBar(root, 'http://x');
  expect(root.querySelector('select[data-control="held"]')).toBeNull();
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

test('self preview shows a muted mirrored video and hides when off', () => {
  const stream = new MediaStream();
  showSelfPreview(root, stream, true);
  const video = root.querySelector('.selfview video') as HTMLVideoElement;
  expect(video.muted).toBe(true);
  expect(video.srcObject).toBe(stream);
  showSelfPreview(root, stream, false);
  expect((root.querySelector('.selfview') as HTMLElement).hidden).toBe(true);
});

test('join screen recommends headphones', () => {
  showJoin(root, { defaultName: '', onJoin: () => {} });
  expect(root.textContent).toContain('Headphones recommended');
});
