// The lobby at /r/<id> (lobby spec §2–3): what others will see and hear, set up before joining.
// User-provided text only ever goes through textContent; the picture is a validated data: URL set as an attribute.
import { NAME_MAX, sanitizeName } from '@zoom3d/shared';
import { makeAvatar } from '../media/avatar';
import type { Device, DeviceProblem } from '../media/devices';
import { initials } from '../media/faces';
import type { LocalMediaController, MediaState } from '../media/local-media';
import { deviceIcon } from './icons';
import { ringWidth } from './mic-level';
import { el, setScreen } from './screens';

export const PROBLEM_TEXT: { cam: Record<DeviceProblem, string>; mic: Record<DeviceProblem, string> } = {
  cam: {
    insecure: 'Camera and mic need HTTPS.',
    blocked: 'Camera blocked: allow it in the address bar.',
    missing: 'No camera found.',
    busy: 'Camera is in use by another app.',
  },
  mic: {
    insecure: 'Camera and mic need HTTPS.',
    blocked: 'Microphone blocked: allow it in the address bar. You can still listen.',
    missing: 'No microphone found.',
    busy: 'Microphone is in use by another app.',
  },
};

const WAITING = 'Waiting for the camera and mic: check the browser’s permission prompt.';
/** Only a request this slow is waiting on the user; a camera restart is quicker and must not flash a line. */
const WAITING_DELAY_MS = 1000;

/** The one device line under Join: the camera's problem first, then the mic's; '' when there is none. */
export function problemLine(state: MediaState): string {
  if (state.camProblem) {
    return PROBLEM_TEXT.cam[state.camProblem];
  }
  return state.micProblem ? PROBLEM_TEXT.mic[state.micProblem] : '';
}

/** The in-room banner for devices that were unavailable at Join; a camera off by choice needs none. */
export function joinBanner(state: MediaState): string | null {
  if (state.camProblem === 'insecure') {
    return 'Camera and mic need HTTPS — joined without them.';
  }
  if (!state.camAvailable && !state.micAvailable) {
    return 'Camera and mic unavailable — others see your picture or initials, you can listen only.';
  }
  if (!state.camAvailable) {
    return 'Camera unavailable — others see your picture or initials.';
  }
  if (!state.micAvailable) {
    return 'Microphone unavailable — you can listen only.';
  }
  return null;
}

export interface LobbyOptions {
  media: LocalMediaController;
  defaultName: string;
  /** Previously picked picture (validated), or null. */
  defaultAvatar: string | null;
  /** Turns a picked file into an avatar data URL; rejects with 'unreadable' or 'too_big'. */
  pickAvatar?: (file: File) => Promise<string>;
  /** Mic level 0..1, sampled once a frame. */
  level?: () => number;
  onJoin(name: string, avatar: string | null): void;
}

const AVATAR_ERRORS: Record<string, string> = {
  too_big: 'That picture is too detailed — try another',
};

interface Split {
  root: HTMLElement;
  render(state: MediaState): void;
}

function splitButton(
  kind: 'cam' | 'mic',
  opts: LobbyOptions,
  closeOthers: (except: HTMLElement | null) => void
): Split {
  const { media } = opts;
  const noun = kind === 'cam' ? 'camera' : 'microphone';
  const toggle = el('button', { type: 'button', className: 'toggle' });
  const chevron = el('button', { type: 'button', className: 'chevron', textContent: '▾' });
  chevron.setAttribute('aria-label', `Choose ${noun}`);
  chevron.setAttribute('aria-haspopup', 'menu');
  const menu = el('div', { className: 'device-menu', hidden: true });
  menu.setAttribute('role', 'menu');
  const root = el('div', { className: 'split' }, toggle, chevron, menu);
  root.dataset.device = kind;
  let on = false;

  toggle.addEventListener('click', () => {
    if (kind === 'cam') {
      void media.setCam(!on);
    } else {
      media.setMic(!on);
    }
  });
  chevron.addEventListener('click', async () => {
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    closeOthers(menu);
    const { cams, mics } = await media.devices();
    const list: Device[] = kind === 'cam' ? cams : mics;
    const prefs = media.prefs();
    const inUse = (kind === 'cam' ? prefs.camId : prefs.micId) ?? list[0]?.id;
    menu.replaceChildren(
      ...list.map((d) => {
        const item = el('button', { type: 'button', textContent: d.label });
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(d.id === inUse));
        item.addEventListener('click', () => {
          menu.hidden = true;
          menu.replaceChildren();
          void (kind === 'cam' ? media.useCamera(d.id) : media.useMic(d.id));
        });
        return item;
      })
    );
    menu.hidden = false;
  });

  return {
    root,
    render(state) {
      // What was asked, not the live track: a device still starting shows as on, so a second click cancels it.
      // A device with a problem shows as off, so a click retries it.
      const prefs = media.prefs();
      const available = kind === 'cam' ? state.camAvailable : state.micAvailable;
      const problem = kind === 'cam' ? state.camProblem : state.micProblem;
      on = (kind === 'cam' ? prefs.cam : prefs.mic) && available && problem === null;
      const label =
        kind === 'cam' ? (on ? 'Turn camera off' : 'Turn camera on') : on ? 'Mute microphone' : 'Unmute microphone';
      toggle.setAttribute('aria-label', label);
      toggle.replaceChildren(deviceIcon(kind, !on));
      toggle.disabled = !available;
      chevron.disabled = !available;
      root.classList.toggle('off', !on);
    },
  };
}

export function showLobby(root: HTMLElement, opts: LobbyOptions): () => void {
  const { media } = opts;
  const pickAvatar = opts.pickAvatar ?? ((file: File) => makeAvatar(file));
  let avatar = opts.defaultAvatar;
  let avatarError = '';
  // Only the latest pick counts; Join waits until it has been encoded.
  let latestPick = 0;
  let encoding = false;

  const video = el('video', { muted: true, autoplay: true, playsInline: true });
  video.srcObject = new MediaStream([media.framer.track]);
  void video.play().catch(() => {});
  const face = el('span', { className: 'face' });
  const pencil = el('button', { type: 'button', className: 'pencil', textContent: '✎' });
  pencil.setAttribute('aria-label', 'Change picture');
  const choose = el('button', { type: 'button', textContent: 'Choose picture…' });
  const remove = el('button', { type: 'button', textContent: 'Remove' });
  const pictureMenu = el('div', { className: 'picture-menu', hidden: true }, choose, remove);
  const disc = el('div', { className: 'lobby-disc avatar' }, video, face, pencil, pictureMenu);
  const file = el('input', { type: 'file', accept: 'image/*', hidden: true });
  file.setAttribute('aria-label', 'Avatar picture');

  /** Each menu with the button that opens it; a press on either one isn't "outside". */
  const menus: { menu: HTMLElement; opener: HTMLElement }[] = [{ menu: pictureMenu, opener: pencil }];
  const closeOthers = (except: HTMLElement | null) => {
    for (const { menu: m } of menus) {
      if (m !== except) {
        m.hidden = true;
      }
    }
  };
  const cam = splitButton('cam', opts, closeOthers);
  const mic = splitButton('mic', opts, closeOthers);
  for (const split of [cam, mic]) {
    menus.push({
      menu: split.root.querySelector('.device-menu') as HTMLElement,
      opener: split.root.querySelector('.chevron') as HTMLElement,
    });
  }
  const closeOnOutsidePress = (e: Event) => {
    const target = e.target as Node;
    for (const { menu, opener } of menus) {
      if (!menu.hidden && !menu.contains(target) && !opener.contains(target)) {
        menu.hidden = true;
      }
    }
  };
  document.addEventListener('pointerdown', closeOnOutsidePress);

  const input = el('input', {
    name: 'name',
    value: opts.defaultName,
    maxLength: NAME_MAX * 2,
    placeholder: 'Your name',
  });
  input.setAttribute('autocomplete', 'nickname');
  const join = el('button', { type: 'submit', textContent: 'Join' });
  const error = el('p', { className: 'error' });
  const form = el('form', {}, input, join);

  // Set once a request has been pending for WAITING_DELAY_MS.
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  function watchPending(pending: boolean) {
    if (!pending) {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
      }
      stallTimer = null;
      stalled = false;
    } else if (stallTimer === null) {
      stallTimer = setTimeout(() => {
        stalled = true;
        render();
      }, WAITING_DELAY_MS);
    }
  }

  function render() {
    const state = media.state();
    watchPending(state.pending);
    video.hidden = !state.cam;
    face.hidden = state.cam;
    if (state.cam) {
      face.replaceChildren();
    } else if (avatar) {
      if (face.querySelector('img')?.getAttribute('src') !== avatar) {
        face.replaceChildren(el('img', { src: avatar, alt: '' }));
      }
    } else {
      face.textContent = initials(input.value);
    }
    pencil.hidden = state.cam;
    if (state.cam) {
      pictureMenu.hidden = true;
    }
    remove.hidden = avatar === null;
    cam.render(state);
    mic.render(state);
    join.disabled = encoding || state.pending;
    error.textContent = avatarError || problemLine(state) || (stalled ? WAITING : '');
  }

  input.addEventListener('input', render);
  pencil.addEventListener('click', () => {
    const open = pictureMenu.hidden;
    closeOthers(null);
    pictureMenu.hidden = !open;
    render();
  });
  choose.addEventListener('click', () => {
    pictureMenu.hidden = true;
    file.click();
  });
  remove.addEventListener('click', () => {
    pictureMenu.hidden = true;
    avatar = null;
    render();
  });
  file.addEventListener('change', () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) {
      return;
    }
    const pick = ++latestPick;
    encoding = true;
    render();
    pickAvatar(picked).then(
      (url) => {
        if (pick !== latestPick) {
          return;
        }
        encoding = false;
        avatar = url;
        avatarError = '';
        render();
      },
      (err: unknown) => {
        if (pick !== latestPick) {
          return;
        }
        encoding = false;
        const code = err instanceof Error ? err.message : '';
        avatarError = AVATAR_ERRORS[code] ?? "Couldn't read that picture";
        render();
      }
    );
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (encoding || media.state().pending) {
      return;
    }
    const name = sanitizeName(input.value);
    if (name === null) {
      avatarError = '';
      error.textContent = `Enter a name (1–${NAME_MAX} characters)`;
      return;
    }
    opts.onJoin(name, avatar);
  });

  const unsubscribe = media.subscribe(render);
  render();
  setScreen(
    root,
    el('div', { className: 'lobby' }, disc, file, el('div', { className: 'devices' }, cam.root, mic.root), form, error)
  );
  input.focus();

  // The ring is redrawn only when its width changes.
  let shownWidth = -1;
  let frame = 0;
  const tick = () => {
    const width = media.state().mic && opts.level ? ringWidth(opts.level()) : 0;
    if (width !== shownWidth) {
      shownWidth = width;
      disc.style.boxShadow = width ? `0 0 0 ${width}px #6c6` : 'none';
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    document.removeEventListener('pointerdown', closeOnOutsidePress);
    cancelAnimationFrame(frame);
    watchPending(false);
    unsubscribe();
    video.srcObject = null;
  };
}
