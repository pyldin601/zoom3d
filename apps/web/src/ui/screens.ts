// DOM screens and overlays inside the stage. User-provided text only ever goes through textContent.
import { initials } from '../media/faces';
import { deviceIcon, touchIcon } from './icons';

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
function slot(root: HTMLElement, cls: string): HTMLElement {
  const existing = root.querySelector<HTMLElement>(`:scope > .${cls}`);
  if (existing) {
    return existing;
  }
  const node = el('div', { className: cls });
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

export interface MediaControls {
  cam: boolean;
  mic: boolean;
  camAvailable: boolean;
  micAvailable: boolean;
  /** Resolves to whether the camera is on now: turning it on can fail. */
  onCam(on: boolean): Promise<boolean>;
  onMic(on: boolean): boolean;
}

function toggle(
  kind: 'cam' | 'mic',
  label: string,
  on: boolean,
  available: boolean,
  onChange: (on: boolean) => boolean | Promise<boolean>
) {
  const button = el('button', { type: 'button', disabled: !available, className: 'toggle' });
  button.dataset.control = kind;
  const render = () => {
    // The same icons as the lobby; the state is in the accessible name.
    button.setAttribute('aria-label', available ? `${label} ${on ? 'on' : 'off'}` : `No ${label.toLowerCase()}`);
    button.setAttribute('aria-pressed', String(on));
    button.classList.toggle('off', !on);
    button.replaceChildren(deviceIcon(kind, !on));
  };
  button.addEventListener('click', async () => {
    on = !on;
    render();
    // The handler has the last word: a camera that couldn't start shows as off again.
    on = await onChange(on);
    render();
  });
  render();
  return button;
}

/** How long the compact copy button says "Copied". */
const COPIED_MS = 2000;

/** The touch room bar's copy button (mobile spec §5.1): no link field, the button alone, "Copied" for a moment. */
function copyLinkButton(inviteUrl: string): HTMLButtonElement {
  const copy = el('button', { type: 'button', className: 'toggle copy-link' });
  copy.setAttribute('aria-label', 'Copy invite link');
  copy.append(touchIcon('link'));
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(inviteUrl).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => copy.replaceChildren(touchIcon('link')), COPIED_MS);
    });
  });
  return copy;
}

export function showRoomBar(
  root: HTMLElement,
  inviteUrl: string,
  controls?: MediaControls,
  { compact = false }: { compact?: boolean } = {}
): void {
  const toggles = controls
    ? [
        toggle('mic', 'Mic', controls.mic, controls.micAvailable, controls.onMic),
        toggle('cam', 'Cam', controls.cam, controls.camAvailable, controls.onCam),
      ]
    : [];
  if (compact) {
    slot(root, 'roombar').replaceChildren(...toggles, copyLinkButton(inviteUrl));
    return;
  }
  const link = el('input', { readOnly: true, value: inviteUrl, ariaLabel: 'Invite link' });
  const copy = el('button', { type: 'button', textContent: 'Copy invite link' });
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(inviteUrl).then(
      () => {
        copy.textContent = 'Copied!';
      },
      () => link.select()
    ) ?? link.select();
  });
  slot(root, 'roombar').replaceChildren(...toggles, link, copy);
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

/** Your own circle: the camera while it is on, else your picture or initials, as others see you. */
export function showSelfPreview(root: HTMLElement, stream: MediaStream | null, self: SelfView): void {
  const box = slot(root, 'selfview');
  let video = box.querySelector('video');
  let face = box.querySelector<HTMLElement>('.face');
  if (!video || !face) {
    video = el('video', { muted: true, autoplay: true, playsInline: true });
    face = el('div', { className: 'face' });
    box.replaceChildren(video, face);
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
