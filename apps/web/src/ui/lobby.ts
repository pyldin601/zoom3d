// The lobby at /r/<id> (lobby spec §2–3): what others will see and hear, set up before joining.
// User-provided text only ever goes through textContent; the picture is a validated data: URL set as an attribute.
import { NAME_MAX_CHARS, sanitizeName } from '@zoom3d/shared';
import { makeAvatar } from '../media/avatar';
import type { Device, DeviceProblem } from '../media/devices';
import { initials } from '../media/faces';
import type { LocalMediaController, MediaState } from '../media/local-media';
import type { MediaPrefs } from '../media/media-prefs';
import { addMeter, deviceIcon, setMeter, touchIcon } from './icons';
import { meterHeight } from './mic-level';
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
  /** This room's link, copied by the button under Join. */
  inviteUrl: string;
  onJoin(name: string, avatar: string | null): void;
}

/** How long the invite button says "Copied". */
const COPIED_MS = 2000;
const COPY_FAILED = "Couldn't copy the link. It's in the address bar.";

const AVATAR_ERRORS: Record<string, string> = {
  too_big: 'That picture is too detailed — try another',
};

/** What differs between the camera's button and the mic's. */
interface DeviceKind {
  kind: 'cam' | 'mic';
  noun: string;
  label(on: boolean): string;
  turn(media: LocalMediaController, on: boolean): void;
  use(media: LocalMediaController, deviceId: string): Promise<void>;
  devices(found: { cams: Device[]; mics: Device[] }): Device[];
  chosenId(prefs: MediaPrefs): string | null;
  asked(prefs: MediaPrefs): boolean;
  available(state: MediaState): boolean;
  problem(state: MediaState): DeviceProblem | null;
}

const CAMERA: DeviceKind = {
  kind: 'cam',
  noun: 'camera',
  label: (on) => (on ? 'Turn camera off' : 'Turn camera on'),
  turn: (media, on) => void media.setCam(on),
  use: (media, id) => media.useCamera(id),
  devices: (found) => found.cams,
  chosenId: (prefs) => prefs.camId,
  asked: (prefs) => prefs.cam,
  available: (state) => state.camAvailable,
  problem: (state) => state.camProblem,
};

const MICROPHONE: DeviceKind = {
  kind: 'mic',
  noun: 'microphone',
  label: (on) => (on ? 'Mute microphone' : 'Unmute microphone'),
  turn: (media, on) => media.setMic(on),
  use: (media, id) => media.useMic(id),
  devices: (found) => found.mics,
  chosenId: (prefs) => prefs.micId,
  asked: (prefs) => prefs.mic,
  available: (state) => state.micAvailable,
  problem: (state) => state.micProblem,
};

/** A menu and the button that opens it: a press on either one isn't "outside". */
interface OpenableMenu {
  menu: HTMLElement;
  opener: HTMLElement;
}

interface Split extends OpenableMenu {
  root: HTMLElement;
  render(state: MediaState): void;
  /** The mic's level fill, in icon units; ignored for the camera and while muted. */
  setLevel(height: number): void;
}

/** A device's on/off button, with a chevron opening its list of devices. */
function splitButton(
  device: DeviceKind,
  media: LocalMediaController,
  closeOthers: (except: HTMLElement | null) => void
): Split {
  const toggle = el('button', { type: 'button', className: 'toggle' });
  const chevron = el('button', { type: 'button', className: 'chevron', textContent: '▾' });
  chevron.setAttribute('aria-label', `Choose ${device.noun}`);
  chevron.setAttribute('aria-haspopup', 'menu');
  const menu = el('div', { className: 'device-menu', hidden: true });
  menu.setAttribute('role', 'menu');
  const root = el('div', { className: 'split' }, toggle, chevron, menu);
  root.dataset.device = device.kind;
  /** null until the first render draws the icon. */
  let on: boolean | null = null;
  let meter: SVGRectElement | null = null;
  let level = 0;

  const listDevices = async () => {
    const list = device.devices(await media.devices());
    const inUse = device.chosenId(media.prefs()) ?? list[0]?.id;
    menu.replaceChildren(
      ...list.map((d) => {
        const item = el('button', { type: 'button', textContent: d.label });
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(d.id === inUse));
        item.addEventListener('click', () => {
          menu.hidden = true;
          menu.replaceChildren();
          void device.use(media, d.id);
        });
        return item;
      })
    );
  };

  /** Rebuilt only when on and off change: render runs on every keystroke in the name field. */
  const drawIcon = (nowOn: boolean) => {
    const icon = deviceIcon(device.kind, !nowOn);
    meter = device.kind === 'mic' && nowOn ? addMeter(icon) : null;
    if (meter) {
      setMeter(meter, level);
    }
    toggle.replaceChildren(icon);
  };

  toggle.addEventListener('click', () => device.turn(media, !on));
  chevron.addEventListener('click', async () => {
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    closeOthers(menu);
    await listDevices();
    menu.hidden = false;
  });

  return {
    root,
    menu,
    opener: chevron,
    render(state) {
      // What was asked, not the live track: a device still starting shows as on, so a second click cancels it.
      // A device with a problem shows as off, so a click retries it.
      const available = device.available(state);
      const nowOn = device.asked(media.prefs()) && available && device.problem(state) === null;
      toggle.setAttribute('aria-label', device.label(nowOn));
      if (nowOn !== on) {
        on = nowOn;
        drawIcon(nowOn);
      }
      toggle.disabled = !available;
      chevron.disabled = !available;
      root.classList.toggle('off', !nowOn);
    },
    setLevel(height) {
      level = height;
      if (meter) {
        setMeter(meter, height);
      }
    },
  };
}

/** The player's disc: the camera's preview, else their picture or initials, with the pencil menu to pick a picture. */
function createPicture(opts: LobbyOptions, closeOthers: (except: HTMLElement | null) => void, render: () => void) {
  const { media } = opts;
  const pickAvatar = opts.pickAvatar ?? ((file: File) => makeAvatar(file));
  let avatar = opts.defaultAvatar;
  let error = '';
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
  const menu = el('div', { className: 'picture-menu', hidden: true }, choose, remove);
  const disc = el('div', { className: 'lobby-disc avatar' }, video, face, pencil, menu);
  const file = el('input', { type: 'file', accept: 'image/*', hidden: true });
  file.setAttribute('aria-label', 'Avatar picture');

  const encode = (picked: File) => {
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
        error = '';
        render();
      },
      (err: unknown) => {
        if (pick !== latestPick) {
          return;
        }
        encoding = false;
        const code = err instanceof Error ? err.message : '';
        error = AVATAR_ERRORS[code] ?? "Couldn't read that picture";
        render();
      }
    );
  };

  pencil.addEventListener('click', () => {
    const open = menu.hidden;
    closeOthers(null);
    menu.hidden = !open;
    render();
  });
  choose.addEventListener('click', () => {
    menu.hidden = true;
    file.click();
  });
  remove.addEventListener('click', () => {
    menu.hidden = true;
    avatar = null;
    render();
  });
  file.addEventListener('change', () => {
    const picked = file.files?.[0];
    file.value = '';
    if (picked) {
      encode(picked);
    }
  });

  return {
    disc,
    file,
    menu: { menu, opener: pencil } satisfies OpenableMenu,
    get avatar() {
      return avatar;
    },
    get error() {
      return error;
    },
    clearError() {
      error = '';
    },
    get encoding() {
      return encoding;
    },
    render(state: MediaState, name: string) {
      // A camera still starting counts as on, so the picture doesn't flash before the first frame.
      const camOn = state.cam || (media.prefs().cam && state.pending && state.camProblem === null);
      video.hidden = !camOn;
      face.hidden = camOn;
      if (camOn) {
        face.replaceChildren();
      } else if (avatar) {
        if (face.querySelector('img')?.getAttribute('src') !== avatar) {
          face.replaceChildren(el('img', { src: avatar, alt: '' }));
        }
      } else {
        face.textContent = initials(name);
      }
      pencil.hidden = camOn;
      if (camOn) {
        menu.hidden = true;
      }
      remove.hidden = avatar === null;
    },
    stop() {
      video.srcObject = null;
    },
  };
}

/** Under Join, after a divider: the lobby is where a host shares the room before joining. The room has no link. */
function createInviteButton(inviteUrl: string, render: () => void) {
  const button = el('button', { type: 'button', className: 'invite-copy' });
  const showCopy = () => button.replaceChildren(touchIcon('link'), 'Copy invite link');
  showCopy();
  let error = '';
  button.addEventListener('click', () => {
    const copied = navigator.clipboard?.writeText(inviteUrl) ?? Promise.reject();
    copied.then(
      () => {
        error = '';
        render();
        button.textContent = 'Copied';
        setTimeout(showCopy, COPIED_MS);
      },
      () => {
        error = COPY_FAILED;
        render();
      }
    );
  });
  return {
    button,
    get error() {
      return error;
    },
  };
}

/** Whether a device request has been pending for WAITING_DELAY_MS: then it's waiting on the user's permission. */
function createStallWatch(render: () => void) {
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watch = (pending: boolean) => {
    if (!pending) {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = null;
      stalled = false;
    } else if (timer === null) {
      timer = setTimeout(() => {
        stalled = true;
        render();
      }, WAITING_DELAY_MS);
    }
  };
  return {
    watch,
    get stalled() {
      return stalled;
    },
    stop: () => watch(false),
  };
}

function closeMenusOnOutsidePress(menus: readonly OpenableMenu[]): () => void {
  const onPress = (e: Event) => {
    const target = e.target as Node;
    for (const { menu, opener } of menus) {
      if (!menu.hidden && !menu.contains(target) && !opener.contains(target)) {
        menu.hidden = true;
      }
    }
  };
  document.addEventListener('pointerdown', onPress);
  return () => document.removeEventListener('pointerdown', onPress);
}

/** The mic's level in its button, redrawn only when its height changes. */
function startMeter(media: LocalMediaController, level: (() => number) | undefined, mic: Split): () => void {
  let shownHeight = -1;
  let frame = 0;
  const tick = () => {
    const height = media.state().mic && level ? meterHeight(level()) : 0;
    if (height !== shownHeight) {
      shownHeight = height;
      mic.setLevel(height);
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

export function showLobby(root: HTMLElement, opts: LobbyOptions): () => void {
  const { media } = opts;
  const menus: OpenableMenu[] = [];
  const closeOthers = (except: HTMLElement | null) => {
    for (const { menu } of menus) {
      if (menu !== except) {
        menu.hidden = true;
      }
    }
  };
  const picture = createPicture(opts, closeOthers, () => render());
  const cam = splitButton(CAMERA, media, closeOthers);
  const mic = splitButton(MICROPHONE, media, closeOthers);
  menus.push(picture.menu, cam, mic);
  const stopClosingMenus = closeMenusOnOutsidePress(menus);

  const nameField = el('input', {
    name: 'name',
    value: opts.defaultName,
    maxLength: NAME_MAX_CHARS * 2,
    placeholder: 'Your name',
  });
  nameField.setAttribute('autocomplete', 'nickname');
  const join = el('button', { type: 'submit', textContent: 'Join' });
  const error = el('p', { className: 'error' });
  const form = el('form', {}, nameField, join);
  const invite = createInviteButton(opts.inviteUrl, () => render());
  const stall = createStallWatch(() => render());

  function render() {
    const state = media.state();
    stall.watch(state.pending);
    picture.render(state, nameField.value);
    cam.render(state);
    mic.render(state);
    join.disabled = picture.encoding || state.pending;
    error.textContent = picture.error || invite.error || problemLine(state) || (stall.stalled ? WAITING : '');
  }

  nameField.addEventListener('input', render);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (picture.encoding || media.state().pending) {
      return;
    }
    const name = sanitizeName(nameField.value);
    if (name === null) {
      picture.clearError();
      error.textContent = `Enter a name (1–${NAME_MAX_CHARS} characters)`;
      return;
    }
    opts.onJoin(name, picture.avatar);
  });

  const unsubscribe = media.subscribe(render);
  render();
  setScreen(
    root,
    el(
      'div',
      { className: 'lobby' },
      picture.disc,
      picture.file,
      el('div', { className: 'devices' }, cam.root, mic.root),
      form,
      error,
      el('div', { className: 'invite' }, invite.button)
    )
  );
  nameField.focus();
  const stopMeter = startMeter(media, opts.level, mic);

  return () => {
    stopClosingMenus();
    stopMeter();
    stall.stop();
    unsubscribe();
    picture.stop();
  };
}
