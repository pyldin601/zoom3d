// DOM screens and overlays inside the 16:9 stage. User-provided text only ever goes through textContent.
import { HELD_ITEMS, type HeldItem, isHeldItem, NAME_MAX, sanitizeName } from '@zoom3d/shared';
import { makeAvatar } from '../media/avatar';
import { initials } from '../media/faces';

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
  if (existing) {
    return existing;
  }
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
    create
  );
}

export interface JoinOptions {
  defaultName: string;
  /** Previously picked picture (validated), or null. */
  defaultAvatar?: string | null;
  error?: string;
  /** Turns a picked file into an avatar data URL; rejects with 'unreadable' or 'too_big'. */
  pickAvatar?: (file: File) => Promise<string>;
  onJoin: (name: string, avatar: string | null) => void;
}

const AVATAR_ERRORS: Record<string, string> = {
  too_big: 'That picture is too detailed — try another',
};

export function showJoin(root: HTMLElement, opts: JoinOptions): void {
  const pickAvatar = opts.pickAvatar ?? ((file: File) => makeAvatar(file));
  let avatar = opts.defaultAvatar ?? null;
  // Only the latest pick counts; Join waits until it has been encoded.
  let latestPick = 0;
  let encoding = false;
  const input = el('input', {
    name: 'name',
    value: opts.defaultName,
    maxLength: NAME_MAX * 2,
    placeholder: 'Your name',
  });
  input.setAttribute('autocomplete', 'nickname');
  const error = el('p', { className: 'error', textContent: opts.error ?? '' });

  const preview = el('div', { className: 'avatar' });
  const file = el('input', { type: 'file', accept: 'image/*', hidden: true });
  file.setAttribute('aria-label', 'Avatar picture');
  const choose = el('button', { type: 'button', textContent: 'Choose picture…' });
  const remove = el('button', { type: 'button', textContent: 'Remove' });
  const renderAvatar = () => {
    // The picture is a validated data: URL, set as an attribute only; names go through textContent.
    preview.replaceChildren(avatar ? el('img', { src: avatar, alt: '' }) : initials(input.value));
    remove.hidden = avatar === null;
  };
  input.addEventListener('input', () => {
    if (!avatar) {
      renderAvatar();
    }
  });
  choose.addEventListener('click', () => file.click());
  remove.addEventListener('click', () => {
    avatar = null;
    renderAvatar();
  });
  file.addEventListener('change', () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) {
      return;
    }
    const pick = ++latestPick;
    setEncoding(true);
    pickAvatar(picked).then(
      (url) => {
        if (pick !== latestPick) {
          return;
        }
        setEncoding(false);
        avatar = url;
        error.textContent = '';
        renderAvatar();
      },
      (err: unknown) => {
        if (pick !== latestPick) {
          return;
        }
        setEncoding(false);
        const code = err instanceof Error ? err.message : '';
        error.textContent = AVATAR_ERRORS[code] ?? "Couldn't read that picture";
      }
    );
  });
  renderAvatar();

  const join = el('button', { type: 'submit', textContent: 'Join' });
  function setEncoding(on: boolean) {
    encoding = on;
    join.disabled = on;
  }
  const form = el(
    'form',
    {},
    el('div', { className: 'avatar-row' }, preview, el('div', {}, choose, remove), file),
    el('label', {}, 'Your name', input),
    join,
    error
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (encoding) {
      return;
    }
    const name = sanitizeName(input.value);
    if (name === null) {
      error.textContent = `Enter a name (1–${NAME_MAX} characters)`;
      return;
    }
    opts.onJoin(name, avatar);
  });
  setScreen(
    root,
    el('h1', { textContent: 'Join the room' }),
    form,
    el('p', { className: 'hint', textContent: 'Headphones recommended.' })
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

function toggle(label: string, control: string, on: boolean, available: boolean, onChange: (on: boolean) => void) {
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

export interface HeldControl {
  held: HeldItem | null;
  onHeld(item: HeldItem | null): void;
}

const HELD_LABELS: Record<HeldItem, string> = { beer: 'Beer', coffee: 'Coffee', wine: 'Wine' };

function heldPicker({ held, onHeld }: HeldControl): HTMLSelectElement {
  const select = el(
    'select',
    {},
    el('option', { value: '', textContent: 'Nothing in hand' }),
    ...HELD_ITEMS.map((item) => el('option', { value: item, textContent: HELD_LABELS[item] }))
  );
  select.dataset.control = 'held';
  select.setAttribute('aria-label', 'In hand');
  select.value = held ?? '';
  select.addEventListener('change', () => {
    onHeld(isHeldItem(select.value) ? select.value : null);
    // Focus would keep letters for the select's typeahead (B, C) instead of the game.
    select.blur();
  });
  return select;
}

export function showRoomBar(root: HTMLElement, inviteUrl: string, controls?: MediaControls, held?: HeldControl): void {
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
  const toggles = controls
    ? [
        toggle('Mic', 'mic', controls.mic, controls.micAvailable, controls.onMic),
        toggle('Cam', 'cam', controls.cam, controls.camAvailable, controls.onCam),
      ]
    : [];
  const picker = held ? [heldPicker(held)] : [];
  slot(root, 'roombar').replaceChildren(...toggles, ...picker, link, copy);
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

export function showSelfPreview(root: HTMLElement, stream: MediaStream | null, visible: boolean): void {
  const box = slot(root, 'selfview');
  let video = box.querySelector('video');
  if (!video) {
    video = el('video', { muted: true, autoplay: true, playsInline: true });
    box.append(video);
  }
  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
  box.hidden = !visible || stream === null;
}
