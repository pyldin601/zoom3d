// DOM screens and overlays inside the 16:9 stage. User-provided text only ever goes through textContent.
import { NAME_MAX, sanitizeName } from '@zoom3d/shared';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** The single child of `root` with class `cls`, created on demand. */
function slot(root: HTMLElement, cls: string): HTMLElement {
  const existing = root.querySelector<HTMLElement>(`:scope > .${cls}`);
  if (existing) return existing;
  const node = el('div', { className: cls });
  root.append(node);
  return node;
}

function setScreen(root: HTMLElement, ...children: Node[]): void {
  slot(root, 'screen').replaceChildren(el('div', { className: 'panel' }, ...children));
}

export function clearScreen(root: HTMLElement): void {
  root.querySelector(':scope > .screen')?.remove();
}

export function showLanding(root: HTMLElement, onCreate: () => void): void {
  const create = el('button', { type: 'button', textContent: 'Create room' });
  create.addEventListener('click', onCreate);
  setScreen(
    root,
    el('h1', { textContent: 'zoom3d' }),
    el('p', { textContent: 'A meeting room you can walk around in.' }),
    create,
  );
}

export function showJoin(
  root: HTMLElement,
  opts: { defaultName: string; error?: string; onJoin: (name: string) => void },
): void {
  const input = el('input', {
    name: 'name',
    value: opts.defaultName,
    maxLength: NAME_MAX * 2,
    placeholder: 'Your name',
  });
  input.setAttribute('autocomplete', 'nickname');
  const error = el('p', { className: 'error', textContent: opts.error ?? '' });
  const form = el(
    'form',
    {},
    el('label', {}, 'Your name', input),
    el('button', { type: 'submit', textContent: 'Join' }),
    error,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = sanitizeName(input.value);
    if (name === null) {
      error.textContent = `Enter a name (1–${NAME_MAX} characters)`;
      return;
    }
    opts.onJoin(name);
  });
  setScreen(
    root,
    el('h1', { textContent: 'Join the room' }),
    form,
    el('p', { className: 'hint', textContent: 'Headphones recommended.' }),
  );
  input.focus();
}

export function showNotice(root: HTMLElement, text: string, linkText: string, href: string): void {
  setScreen(root, el('p', { textContent: text }), el('a', { href, textContent: linkText }));
}

export function showStatus(root: HTMLElement, text: string | null): void {
  if (text === null) {
    root.querySelector(':scope > .status')?.remove();
    return;
  }
  slot(root, 'status').textContent = text;
}

export interface MediaControls {
  cam: boolean;
  mic: boolean;
  camAvailable: boolean;
  micAvailable: boolean;
  onCam(on: boolean): void;
  onMic(on: boolean): void;
}

function toggle(
  label: string,
  control: string,
  on: boolean,
  available: boolean,
  onChange: (on: boolean) => void,
) {
  const button = el('button', { type: 'button', disabled: !available });
  button.dataset.control = control;
  const render = () => {
    button.textContent = available ? `${label} ${on ? 'on' : 'off'}` : `No ${label.toLowerCase()}`;
    button.setAttribute('aria-pressed', String(on));
  };
  button.addEventListener('click', () => {
    on = !on;
    render();
    onChange(on);
  });
  render();
  return button;
}

export function showRoomBar(root: HTMLElement, inviteUrl: string, controls?: MediaControls): void {
  const link = el('input', { readOnly: true, value: inviteUrl, ariaLabel: 'Invite link' });
  const copy = el('button', { type: 'button', textContent: 'Copy invite link' });
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(inviteUrl).then(
      () => {
        copy.textContent = 'Copied!';
      },
      () => link.select(),
    ) ?? link.select();
  });
  const toggles = controls
    ? [
        toggle('Mic', 'mic', controls.mic, controls.micAvailable, controls.onMic),
        toggle('Cam', 'cam', controls.cam, controls.camAvailable, controls.onCam),
      ]
    : [];
  slot(root, 'roombar').replaceChildren(...toggles, link, copy);
}

const BANNER_MS = 8000;
const bannerTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export function showBanner(root: HTMLElement, text: string | null): void {
  const existing = root.querySelector<HTMLElement>(':scope > .banner');
  if (existing) clearTimeout(bannerTimers.get(existing));
  if (text === null) {
    existing?.remove();
    return;
  }
  const banner = slot(root, 'banner');
  banner.textContent = text;
  bannerTimers.set(
    banner,
    setTimeout(() => banner.remove(), BANNER_MS),
  );
}

export function showSelfPreview(root: HTMLElement, stream: MediaStream | null, visible: boolean): void {
  const box = slot(root, 'selfview');
  let video = box.querySelector('video');
  if (!video) {
    video = el('video', { muted: true, autoplay: true, playsInline: true });
    box.append(video);
  }
  if (video.srcObject !== stream) video.srcObject = stream;
  box.hidden = !visible || stream === null;
}
