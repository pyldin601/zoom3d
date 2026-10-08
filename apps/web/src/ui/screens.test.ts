// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { clearScreen, showJoin, showLanding, showNotice, showRoomBar, showStatus } from './screens';

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
  expect(onJoin).toHaveBeenCalledWith('<img src=x onerror=1>');
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
