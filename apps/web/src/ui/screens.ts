// DOM screens and overlays inside the stage. User-provided text only ever goes through textContent.
import { initials } from '../media/faces';
import { deviceIcon, peopleIcon } from './icons';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** The single child of `root` with class `cls`, created on demand. */
function slot<K extends keyof HTMLElementTagNameMap = 'div'>(
  root: HTMLElement,
  cls: string,
  tag = 'div' as K
): HTMLElementTagNameMap[K] {
  const existing = root.querySelector<HTMLElementTagNameMap[K]>(`:scope > .${cls}`);
  if (existing) {
    return existing;
  }
  const node = el(tag);
  node.className = cls;
  root.append(node);
  return node;
}

export function setScreen(root: HTMLElement, ...children: Node[]): void {
  slot(root, 'screen').replaceChildren(el('div', { className: 'panel' }, ...children));
}

export function clearScreen(root: HTMLElement): void {
  root.querySelector(':scope > .screen')?.remove();
}

/** The landing panel, in the lobby's style; main.ts draws the title picture behind it (landing-scene.ts). */
export function showLanding(root: HTMLElement, onCreate: () => void): void {
  const create = el('button', { type: 'button', className: 'primary', textContent: 'Start a party' });
  create.addEventListener('click', onCreate);
  setScreen(
    root,
    el(
      'div',
      { className: 'lobby landing' },
      el('h1', { textContent: 'zoom3d' }),
      el('p', { textContent: 'Beer with your buddies in raycaster.' }),
      create,
      el('a', { href: '/privacy.html', className: 'privacy', textContent: 'Privacy' })
    )
  );
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

/** The room's people count, top right: everyone in the room, the local player included. null removes it. */
export function showPeopleCount(root: HTMLElement, count: number | null): void {
  if (count === null) {
    root.querySelector(':scope > .people')?.remove();
    return;
  }
  const box = slot(root, 'people');
  let number = box.querySelector('span');
  if (!number) {
    number = el('span');
    box.append(peopleIcon(), number);
  }
  number.textContent = String(count);
  box.title = `${count} ${count === 1 ? 'person' : 'people'} in the room`;
}

export interface MediaControls {
  cam: boolean;
  mic: boolean;
  camAvailable: boolean;
  micAvailable: boolean;
  /** Resolves to whether the camera is on now: turning it on can fail. */
  onCam(on: boolean): Promise<boolean>;
  onMic(on: boolean): boolean;
}

interface ToggleOptions {
  kind: 'cam' | 'mic';
  label: string;
  on: boolean;
  available: boolean;
  /** Resolves to whether it is on now: the handler has the last word. */
  onChange(on: boolean): boolean | Promise<boolean>;
  /** The mic button shows the device icon; the self-view shows the player's face, with a hover hint of what a click does. */
  look: 'icon' | 'hint';
}

/** Makes `button` a mic or cam toggle. */
function makeToggle(
  button: HTMLButtonElement,
  { kind, label, on: startsOn, available, onChange, look }: ToggleOptions
) {
  let on = startsOn;
  button.type = 'button';
  button.disabled = !available;
  button.dataset.control = kind;
  const render = () => {
    // The state is in the accessible name.
    button.setAttribute('aria-label', available ? `${label} ${on ? 'on' : 'off'}` : `No ${label.toLowerCase()}`);
    button.setAttribute('aria-pressed', String(on));
    button.classList.toggle('off', !on);
    if (look === 'icon') {
      button.replaceChildren(deviceIcon(kind, !on));
    } else {
      slot(button, 'hint', 'span').replaceChildren(deviceIcon(kind, on));
    }
  };
  button.addEventListener('click', async () => {
    on = !on;
    render();
    // The handler has the last word: a camera that couldn't start shows as off again.
    on = await onChange(on);
    render();
  });
  render();
}

/** Bottom right: a round mic button, and the self-view circle, which turns the camera off and on when clicked. */
export function showMediaControls(root: HTMLElement, controls: MediaControls): void {
  makeToggle(slot(root, 'mic-toggle', 'button'), {
    kind: 'mic',
    label: 'Mic',
    on: controls.mic,
    available: controls.micAvailable,
    onChange: controls.onMic,
    look: 'icon',
  });
  makeToggle(slot(root, 'selfview', 'button'), {
    kind: 'cam',
    label: 'Cam',
    on: controls.cam,
    available: controls.camAvailable,
    onChange: controls.onCam,
    look: 'hint',
  });
}

const BANNER_MS = 8000;
const bannerTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export function showBanner(root: HTMLElement, text: string | null): void {
  const existing = root.querySelector<HTMLElement>(':scope > .banner');
  if (existing) {
    clearTimeout(bannerTimers.get(existing));
  }
  if (text === null) {
    existing?.remove();
    return;
  }
  const banner = slot(root, 'banner');
  banner.textContent = text;
  bannerTimers.set(
    banner,
    setTimeout(() => banner.remove(), BANNER_MS)
  );
}

export interface SelfView {
  cam: boolean;
  name: string;
  /** Validated picture data: URL, or null for initials. */
  avatar: string | null;
}

/** The self-view circle: the camera while it is on, else the player's picture or initials, as others see them. */
export function showSelfPreview(root: HTMLElement, stream: MediaStream | null, self: SelfView): void {
  const box = slot(root, 'selfview', 'button');
  let video = box.querySelector('video');
  let face = box.querySelector<HTMLElement>('.face');
  if (!video || !face) {
    video = el('video', { muted: true, autoplay: true, playsInline: true });
    face = el('div', { className: 'face' });
    // Prepended: the camera toggle's hint stays on top.
    box.prepend(video, face);
  }
  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
  video.hidden = !self.cam;
  face.hidden = self.cam;
  // The picture is set as an attribute only; the name only ever as text.
  face.replaceChildren(self.avatar ? el('img', { src: self.avatar, alt: '' }) : initials(self.name));
  box.hidden = false;
}
