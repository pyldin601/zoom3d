// The page: the landing picture, the lobby, then the room loop. It wires the modules together and owns the page's
// state; what can be pure lives in the modules (the other people in game/remote-world.ts, the room's keys in
// input/room-keys.ts, the drink key in input/drink-key.ts).
import { type HeldItem, LEVEL1, newRoomId, parseMap } from '@zoom3d/shared';
import { preferPlayAndRecord } from './audio/audio-session';
import { HIDDEN_TICK_MS, startHiddenTicker } from './audio/ticker';
import { createFrameRateMeter } from './game/frame-rate';
import { findPageElements, pageStorage, readPageFlags } from './game/page';
import { createRemoteWorld, type PeerMedia } from './game/remote-world';
import { isConnected, joinRoom, type Room } from './game/room';
import { createScreen } from './game/screen';
import { createYou } from './game/you';
import { createDrinkKey } from './input/drink-key';
import { createInput } from './input/keyboard';
import { lockPointer } from './input/pointer-lock';
import { type RoomKey, roomKey } from './input/room-keys';
import { createTouchInput } from './input/touch';
import { loadAvatar, saveAvatar } from './media/avatar';
import { createFramer } from './media/framer';
import { createFramingMemory } from './media/framing-memory';
import { createLocalMedia, type LocalMediaController } from './media/local-media';
import { loadMediaPrefs, saveMediaPrefs } from './media/media-prefs';
import { createOwnGlowSampler } from './media/own-glow';
import { createSubscription } from './media/subscription';
import { type RoomScene, renderHud, renderView } from './renderer/frame';
import { bakeRoomLightingOnce } from './renderer/room-lighting';
import { makeTextures } from './renderer/textures';
import { flushOnHide, initAnalytics, track } from './telemetry/analytics';
import { mediaOutcome } from './telemetry/onboarding';
import { initSentry } from './telemetry/sentry';
import { createBacktickConsole } from './ui/backtick-console';
import { loadBoomboxVolume, saveBoomboxVolume } from './ui/boombox-store';
import { heldKeyAction, loadHeld, saveHeld } from './ui/held-store';
import { joinBanner, PROBLEM_TEXT, showLobby } from './ui/lobby';
import { createMicLevel } from './ui/mic-level';
import { loadName, saveName } from './ui/name-store';
import { litReflections, loadRenderSettings, saveRenderSettings } from './ui/render-settings';
import { statusText } from './ui/room-status';
import { botsParam, parseRoute } from './ui/route';
import {
  clearScreen,
  showBanner,
  showLanding,
  showMediaControls,
  showNotice,
  showPeopleCount,
  showSelfPreview,
  showStatus,
} from './ui/screens';
import { showTouchControls, type TouchControls } from './ui/touch-controls';

initSentry(import.meta.env.VITE_SENTRY_DSN, import.meta.env.VITE_RELEASE);
initAnalytics(import.meta.env.VITE_AMPLITUDE_API_KEY, import.meta.env.VITE_RELEASE);

const flags = readPageFlags(location.search, (query) => matchMedia(query).matches);
document.documentElement.classList.toggle('touch', flags.touch);
const page = findPageElements(document);
const { game, ui, hudCtx } = page;

const map = parseMap(LEVEL1);
const textures = makeTextures(1);
const roomLighting = bakeRoomLightingOnce(map, textures, flags.lights);
/** The renderer's console options (the lighting mode), kept per browser. */
let renderSettings = loadRenderSettings(pageStorage());
const screen = createScreen(page, flags);
/** Counts every drawn room frame and times its drawing; the backtick panel shows the rate and the render time. */
const frameRateMeter = createFrameRateMeter();

// You.

const you = createYou(map, Math.random);
const { player } = you;
const touch = createTouchInput({ surface: game, win: window, doc: document, surfaceWidth: () => game.clientWidth });
const input = createInput(window, document, touch);
/** The held drink's key or touch button: a tap sips, a long press cheers (held items spec §2.4). */
const drinkKey = createDrinkKey({
  gesture: you.gesture,
  // Nothing during a reconnect: the others would never see it.
  canGesture: inRoom,
  onGesture(kind) {
    if (kind === 'sip') {
      room?.session.sendDrink();
    } else {
      room?.session.sendCheers();
    }
    track({ name: kind });
  },
});

// The room, from Join on.

let room: Room | null = null;
/** Everyone else and the world objects, as this frame draws them. */
const world = createRemoteWorld();
/** What the world shows of each peer's media. */
const peerMedia: PeerMedia = {
  faceOf: (id) => room?.call.faceOf(id) ?? null,
  speaking: (id) => room?.audio.speaking(id) ?? 0,
};

function inRoom(): boolean {
  return isConnected(room);
}

// pagehide, not unload: it fires on mobile and for pages entering the back/forward cache.
window.addEventListener('pagehide', () => {
  room?.tracker.leave();
  flushOnHide();
});

/** The one path for changing the drink in hand, from a number key or the touch tray. */
function chooseHeld(item: HeldItem | null): void {
  if (!you.takeDrink(item)) {
    return;
  }
  drinkKey.cancel();
  refreshTouchControls();
  saveHeld(pageStorage(), item);
  room?.session.setHeld(item);
  if (item !== null) {
    track({ name: 'drink_picked', item });
  }
}

// Mouse-look only: iOS has no pointer lock, and a finger on the view turns by dragging instead (mobile spec §4.1).
game.addEventListener('pointerdown', (e) => {
  if (inRoom() && e.pointerType === 'mouse' && e.button === 0) {
    lockPointer(game);
  }
});

// Browsers may suspend audio until a gesture (autoplay policy, backgrounded tab): resume on the next one.
for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(type, () => void room?.audio.resume());
}

const backtickConsole = createBacktickConsole(ui, {
  panel: () => ({
    frameRate: frameRateMeter.fps,
    renderLoad: frameRateMeter.renderLoad,
    facesSent: () => room?.call.sendingFaces() ?? { 256: false, 128: false, 64: false },
    render: {
      settings: renderSettings,
      onChange(s) {
        renderSettings = s;
        saveRenderSettings(pageStorage(), s);
      },
    },
  }),
  boombox: () => room?.boombox ?? null,
  saveBoomboxVolume: (volume) => saveBoomboxVolume(pageStorage(), volume),
});

// The room's keys; walking is keyboard.ts's.

window.addEventListener('keydown', (e) => {
  // A modifier mid-press means a shortcut, and macOS never reports a key released while Cmd is held: forget the press.
  if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') {
    drinkKey.cancel();
  }
  const key = roomKey(e, { inRoom: inRoom(), hasBoombox: room !== null });
  if (key) {
    onRoomKey(key, e);
  }
});
window.addEventListener('keyup', (e) => drinkKey.up(e.timeStamp, e.code));
// A key released in another window never reports keyup here: forget the press.
window.addEventListener('blur', () => drinkKey.cancel());

function onRoomKey(key: RoomKey, e: KeyboardEvent): void {
  switch (key.kind) {
    case 'console':
      e.preventDefault();
      backtickConsole.toggle();
      break;
    case 'map':
      e.preventDefault();
      if (!key.repeat) {
        toggleAutomap();
      }
      break;
    case 'boombox':
      e.preventDefault();
      toggleBoombox();
      break;
    case 'drink':
      // 1–3 pick a drink, 0 puts it down; the drink in hand's own key sips or cheers it.
      e.preventDefault();
      if (heldKeyAction(key.item, you.drink) === 'pick') {
        chooseHeld(key.item);
      } else {
        drinkKey.down(e.timeStamp, key.code);
      }
      break;
    case 'media':
      // The same as pressing the mic button or your own circle (feedback, a camera that can't start, a missing device
      // and all).
      ui.querySelector<HTMLButtonElement>(`button[data-control="${key.control}"]`)?.click();
      break;
  }
}

/** B opens the boombox's file picker, or stops the music (boombox spec §3); stopping works while reconnecting. */
function toggleBoombox(): void {
  room?.boombox.toggle(inRoom());
}

let automapVisible = false;
function toggleAutomap(): void {
  automapVisible = !automapVisible;
  refreshTouchControls();
}

// Touch controls.

/** The room's touch controls (mobile spec §5): from Join in touch mode, else from the first touch in the room. */
let touchControls: TouchControls | null = null;
function showTouch(): void {
  if (touchControls || !room) {
    return;
  }
  touchControls = showTouchControls(ui, {
    held: you.drink,
    boombox: you.boombox,
    map: automapVisible,
    onPick(item) {
      if (inRoom()) {
        chooseHeld(item);
      }
    },
    onDrinkDown: (t) => {
      if (inRoom()) {
        drinkKey.down(t, 'touch');
      }
    },
    onDrinkUp: (t) => drinkKey.up(t, 'touch'),
    onDrinkCancel: () => drinkKey.cancel('touch'),
    onBoombox: toggleBoombox,
    onMap: () => {
      if (inRoom()) {
        toggleAutomap();
      }
    },
  });
  touch.attachPad(touchControls.pad);
}
function refreshTouchControls(): void {
  touchControls?.update({ held: you.drink, boombox: you.boombox, map: automapVisible });
}
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    showTouch();
  }
});

// The room's status line and head count, written only when they change.

let shownStatus: string | null = null;
function setStatus(text: string | null): void {
  if (text === shownStatus) {
    return;
  }
  showStatus(ui, text);
  shownStatus = text;
}

let shownPeople: number | null = null;
function setPeopleCount(count: number | null): void {
  if (count === shownPeople) {
    return;
  }
  showPeopleCount(ui, count);
  shownPeople = count;
}

// Joining.

function enterRoom(
  roomId: string,
  name: string,
  avatar: string | null,
  local: LocalMediaController,
  audioCtx: AudioContext
): void {
  saveName(pageStorage(), name);
  saveAvatar(pageStorage(), avatar);
  clearScreen(ui);
  you.takeDrink(loadHeld(pageStorage()));
  const joined = joinRoom({
    roomId,
    name,
    avatar,
    local,
    audioCtx,
    map,
    player,
    mediaContainer: page.media,
    localMediaContainer: page.localMedia,
    drink: you.drink,
    boomboxVolume: loadBoomboxVolume(pageStorage()),
    onBoomboxChange(on) {
      you.boombox = on;
      refreshTouchControls();
      backtickConsole.refreshBoombox();
    },
  });
  room = joined;
  const banner = joinBanner(local.state());
  if (banner) {
    showBanner(ui, banner);
  }
  const activeCall = joined.call;
  const media = local.state();
  showMediaControls(ui, {
    cam: media.cam,
    mic: media.mic,
    camAvailable: media.camAvailable,
    micAvailable: media.micAvailable,
    async onCam(on) {
      const now = await activeCall.setCam(on);
      showSelfPreview(ui, local.stream, { cam: now, name, avatar });
      const problem = local.state().camProblem;
      if (on && !now && problem) {
        showBanner(ui, PROBLEM_TEXT.cam[problem]);
      }
      return now;
    },
    onMic: (on) => activeCall.setMic(on),
  });
  showSelfPreview(ui, local.stream, { cam: media.cam, name, avatar });
  if (flags.touch) {
    showTouch();
  }
  if (new URLSearchParams(location.search).has('debug')) {
    backtickConsole.toggle();
  }
}

// The route: the landing page, a lobby, or a bad link.

const route = parseRoute(location.pathname);
/** The room this page load created with "Start a party": its lobby counts as the host's, any other as an invite. */
let hostedRoom: string | null = null;
// "Start a party" changes the URL without a page load; going back or forward loads the page for that URL again.
window.addEventListener('popstate', () => location.reload());

if (route.kind === 'landing') {
  track({ name: 'landing_viewed' });
  showLanding(ui, () => {
    // Stays in the page (no reload), so the in-memory analytics id carries the funnel into the lobby.
    const roomId = newRoomId(crypto.getRandomValues(new Uint8Array(16)));
    hostedRoom = roomId;
    track({ name: 'party_started' });
    // `/?bots=N` carries into the room link, so the join that creates the room asks for bots.
    const bots = botsParam(location.search);
    history.pushState(null, '', `/r/${roomId}${bots ? `?bots=${bots}` : ''}`);
    screen.showLobbyPicture();
    openLobby(roomId);
  });
} else if (route.kind === 'invalid') {
  showNotice(ui, 'Bad room link', 'Start a new room', '/');
} else {
  openLobby(route.roomId);
}

/** The lobby owns the camera, mic and AudioContext from here on; Join hands them to the room (lobby spec §4.5). */
function openLobby(roomId: string): void {
  // Before any capture: on iOS this keeps voices audible with the ringer switch on silent (mobile spec §6).
  preferPlayAndRecord(navigator as { audioSession?: { type: string } });
  // Created now for the mic meter; a browser that keeps it suspended lets it start on the first click or key.
  const audioCtx = new AudioContext({ latencyHint: 'interactive' });
  const resume = () => void audioCtx.resume();
  window.addEventListener('pointerdown', resume, { once: true });
  window.addEventListener('keydown', resume, { once: true });
  const local = createLocalMedia(
    {
      isSecureContext: window.isSecureContext,
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
      onDeviceChange: (cb) => navigator.mediaDevices?.addEventListener('devicechange', cb),
      framer: createFramer({ container: page.localMedia, document, memory: createFramingMemory(pageStorage()) }),
    },
    loadMediaPrefs(pageStorage())
  );
  const ownFace = createOwnGlowSampler(local.framer.canvas, document);
  // Kept from the controller's notifications (every camera change notifies), not asked of it every frame.
  let camOn = local.state().cam;
  local.subscribe(() => {
    camOn = local.state().cam;
  });
  you.useCameraColour((now) => (camOn ? ownFace.colour(now) : null));
  track({ name: 'lobby_viewed', entry: roomId === hostedRoom ? 'host' : 'invite' });
  void local.ready.then(() => track({ name: 'media_permission', ...mediaOutcome(local.state()) }));
  // Saved for the whole visit, so the room's Cam/Mic buttons are remembered too.
  local.subscribe(() => saveMediaPrefs(pageStorage(), local.prefs()));
  const meter = createMicLevel(audioCtx);
  meter.setTrack(local.micTrack());
  const stopMetering = local.subscribe(() => meter.setTrack(local.micTrack()));
  const closeLobby = showLobby(ui, {
    media: local,
    defaultName: loadName(pageStorage()),
    defaultAvatar: loadAvatar(pageStorage()),
    level: meter.level,
    inviteUrl: location.href,
    onJoin(name, avatar) {
      // Resumed synchronously inside the Join click (user gesture), before anything else.
      void audioCtx.resume();
      closeLobby();
      stopMetering();
      meter.dispose();
      screen.runRoom(frame);
      enterRoom(roomId, name, avatar, local, audioCtx);
    },
  });
}

// Dev-only inspection hook for manual checks and e2e tests.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __game: {
      map,
      player,
      input,
      get session() {
        return room?.session ?? null;
      },
      get call() {
        return room?.call ?? null;
      },
      get audio() {
        return room?.audio ?? null;
      },
    },
  });
}

const subscription = createSubscription();

/** Dynamic subscription (6c spec §4): whose face and voice to receive. */
function chooseWhatToReceive(r: Room, now: number, hidden: boolean): void {
  subscription.choose(now, {
    call: r.call,
    people: r.session.peers,
    positions: world.positions,
    player,
    fov: screen.fb.fov,
    map,
    maxDistance: r.audio.settings().max,
    hidden,
  });
}

// The room loop.

// rAF stops while the tab is hidden: keep voices (and newcomers) audible from a timer meanwhile.
startHiddenTicker(
  () => {
    if (!room) {
      return;
    }
    const now = performance.now();
    world.sample(room.session, player, now);
    room.objectSounds.sync(room.session.objects, world.objectPoses, HIDDEN_TICK_MS / 1000);
    room.audio.update(now, player, world.positions);
    chooseWhatToReceive(room, now, true);
  },
  () => document.hidden
);

function frame(dt: number): void {
  stepSelf(dt);
  const now = performance.now();
  if (room) {
    room.call.update(now);
    updateWorld(room, now, dt);
  }
  const drawStart = performance.now();
  const shown = describeScene(drawStart);
  renderView(screen.fb, shown, subscription.seen);
  screen.present();
  renderHud(hudCtx, screen.fb, shown, automapVisible);
  const drawnAt = performance.now();
  // dt comes from rAF's timestamps, which fall on the screen's refreshes.
  frameRateMeter.frame(drawnAt, dt * 1000, drawnAt - drawStart);
  if (room) {
    chooseWhatToReceive(room, drawnAt, document.hidden);
  }
}

/** Your own move this frame: the mouse or drag turn, keys or pad, and your walking bob. */
function stepSelf(dt: number): void {
  // Consumed outside the room too, so a turn made before it doesn't land on the first frame in it.
  const mouseTurn = input.consumeMouseTurn();
  if (!inRoom()) {
    return;
  }
  you.walk(map, input.state(), mouseTurn, dt);
}

/** Everyone else and the world objects this frame, their sounds, and the room's status line and head count. */
function updateWorld(r: Room, now: number, dt: number): void {
  const { session } = r;
  world.sample(session, player, now);
  world.collect(session, peerMedia, now, dt);
  r.objectSounds.sync(session.objects, world.objectPoses, dt);
  setStatus(statusText(session.status(), session.error()));
  // Bots count too: the client can't tell them from people.
  setPeopleCount(session.status() === 'open' ? session.peers.size + 1 : null);
  r.audio.update(now, player, world.positions);
}

/** Refilled every frame by describeScene. */
const scene: RoomScene = {
  map,
  textures,
  eye: player,
  lighting: null,
  reflections: 'none',
  people: world.sprites,
  objects: world.voxels,
  labels: world.labels,
  yourGlow: null,
  inYourHands: null,
};

function describeScene(now: number): RoomScene {
  // The console's lighting mode; flat is drawn unlit, as with `?lights=off`.
  const reflections = litReflections(renderSettings.mode);
  scene.lighting = reflections === null ? null : roomLighting();
  scene.reflections = reflections ?? 'none';
  scene.yourGlow = you.glow(now, room?.session.selfColor() ?? null);
  scene.inYourHands = inRoom() ? you.hands(now) : null;
  return scene;
}

if (route.kind === 'invalid') {
  screen.runRoom(frame);
} else if (route.kind === 'landing') {
  screen.showTitle();
} else {
  screen.showLobbyPicture();
}
