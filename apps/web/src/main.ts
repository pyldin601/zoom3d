// The page: the landing picture, then the lobby, then the room. main.ts makes the page's parts once and wires them
// together; each part is its own module.
import { type HeldItem, LEVEL1, newRoomId, parseMap } from '@zoom3d/shared';
import { startHiddenTicker } from './audio/ticker';
import { createFrameRateMeter } from './game/frame-rate';
import { type LobbyJoin, openLobby } from './game/lobby-flow';
import { findPageElements, pageStorage, readPageFlags } from './game/page';
import { isConnected, joinRoom, type Room } from './game/room';
import { createRoomControls } from './game/room-controls';
import { createRoomLoop } from './game/room-loop';
import { createScreen } from './game/screen';
import { createYou } from './game/you';
import { createDrinkKey } from './input/drink-key';
import { createInput } from './input/keyboard';
import { lockPointer } from './input/pointer-lock';
import { createTouchInput } from './input/touch';
import { saveAvatar } from './media/avatar';
import { bakeRoomLightingOnce } from './renderer/room-lighting';
import type { Gesture } from './renderer/sip';
import { makeTextures } from './renderer/textures';
import { flushOnHide, initAnalytics, track } from './telemetry/analytics';
import { initSentry } from './telemetry/sentry';
import { createBacktickConsole } from './ui/backtick-console';
import { loadBoomboxVolume, saveBoomboxVolume } from './ui/boombox-store';
import { loadHeld, saveHeld } from './ui/held-store';
import { saveName } from './ui/name-store';
import { loadRenderSettings, saveRenderSettings } from './ui/render-settings';
import { showRoomScreen } from './ui/room-screen';
import { createStatusLine } from './ui/room-status';
import { botsParam, parseRoute, type Route } from './ui/route';
import { clearScreen, showLanding, showNotice } from './ui/screens';

initSentry(import.meta.env.VITE_SENTRY_DSN, import.meta.env.VITE_RELEASE);
initAnalytics(import.meta.env.VITE_AMPLITUDE_API_KEY, import.meta.env.VITE_RELEASE);

const flags = readPageFlags(location.search, (query) => matchMedia(query).matches);
document.documentElement.classList.toggle('touch', flags.touch);
const page = findPageElements(document);
const map = parseMap(LEVEL1);
const textures = makeTextures(1);
const roomLighting = bakeRoomLightingOnce(map, textures, flags.lights);
const screen = createScreen(page, flags);
const frameRateMeter = createFrameRateMeter();
/** The lighting mode, chosen in the backtick console and kept per browser. */
let renderSettings = loadRenderSettings(pageStorage());

const you = createYou(map, Math.random);
const touch = createTouchInput({
  surface: page.game,
  win: window,
  doc: document,
  surfaceWidth: () => page.game.clientWidth,
});
const input = createInput(window, document, touch);
const drinkKey = createDrinkKey({ gesture: you.gesture, canGesture: inRoom, onGesture: sendGesture });

let room: Room | null = null;
const backtickConsole = createBacktickConsole(page.ui, {
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
const controls = createRoomControls({
  ui: page.ui,
  touch,
  you,
  drinkKey,
  room: () => room,
  chooseDrink,
  toggleConsole: () => backtickConsole.toggle(),
});
const roomLoop = createRoomLoop({
  map,
  textures,
  you,
  input,
  screen,
  hud: page.hudCtx,
  frameRate: frameRateMeter,
  statusLine: createStatusLine(page.ui),
  room: () => room,
  renderMode: () => renderSettings.mode,
  roomLighting,
  showMap: () => controls.mapShown,
});
// rAF stops while the tab is hidden: keep voices (and newcomers) audible from a timer meanwhile.
startHiddenTicker(roomLoop.whileHidden, () => document.hidden);

listenToThePage();
if (import.meta.env.DEV) {
  exposeForTests();
}
showRoute(parseRoute(location.pathname));

function inRoom(): boolean {
  return isConnected(room);
}

function showRoute(route: Route): void {
  switch (route.kind) {
    case 'landing':
      track({ name: 'landing_viewed' });
      showLanding(page.ui, startParty);
      screen.showTitle();
      break;
    case 'room':
      showLobbyFor(route.roomId, 'invite');
      break;
    case 'invalid':
      showNotice(page.ui, 'Bad room link', 'Start a new room', '/');
      screen.runRoom(roomLoop.frame);
      break;
  }
}

/** Stays in the page (no reload), so the in-memory analytics id carries the funnel into the lobby. */
function startParty(): void {
  const roomId = newRoomId(crypto.getRandomValues(new Uint8Array(16)));
  track({ name: 'party_started' });
  // `/?bots=N` carries into the room link, so the join that creates the room asks for bots.
  const bots = botsParam(location.search);
  history.pushState(null, '', `/r/${roomId}${bots ? `?bots=${bots}` : ''}`);
  showLobbyFor(roomId, 'host');
}

function showLobbyFor(roomId: string, entry: 'host' | 'invite'): void {
  screen.showLobbyPicture();
  openLobby({ page, you, entry, onJoin: (join) => enterRoom(roomId, join) });
}

function enterRoom(roomId: string, { name, avatar, local, audioCtx }: LobbyJoin): void {
  screen.runRoom(roomLoop.frame);
  saveName(pageStorage(), name);
  saveAvatar(pageStorage(), avatar);
  clearScreen(page.ui);
  you.takeDrink(loadHeld(pageStorage()));
  room = joinRoom({
    roomId,
    name,
    avatar,
    local,
    audioCtx,
    map,
    player: you.player,
    mediaContainer: page.media,
    localMediaContainer: page.localMedia,
    drink: you.drink,
    boomboxVolume: loadBoomboxVolume(pageStorage()),
    onBoomboxChange(on) {
      you.boombox = on;
      controls.refresh();
      backtickConsole.refreshBoombox();
    },
  });
  showRoomScreen(page.ui, { call: room.call, local, name, avatar });
  if (flags.touch) {
    controls.showTouchControls();
  }
  if (new URLSearchParams(location.search).has('debug')) {
    backtickConsole.toggle();
  }
}

/** The one path for changing the drink in hand, from a number key or the touch tray. */
function chooseDrink(item: HeldItem | null): void {
  if (!you.takeDrink(item)) {
    return;
  }
  drinkKey.cancel();
  controls.refresh();
  saveHeld(pageStorage(), item);
  room?.session.setHeld(item);
  if (item !== null) {
    track({ name: 'drink_picked', item });
  }
}

/** Only called while in the room: drinkKey asks inRoom first, as a gesture during a reconnect would never arrive. */
function sendGesture(kind: Gesture): void {
  if (kind === 'sip') {
    room?.session.sendDrink();
  } else {
    room?.session.sendCheers();
  }
  track({ name: kind });
}

function listenToThePage(): void {
  // pagehide, not unload: it fires on mobile and for pages entering the back/forward cache.
  window.addEventListener('pagehide', () => {
    room?.tracker.leave();
    flushOnHide();
  });
  // Mouse-look only: iOS has no pointer lock, and a finger on the view turns by dragging instead (mobile spec §4.1).
  page.game.addEventListener('pointerdown', (e) => {
    if (inRoom() && e.pointerType === 'mouse' && e.button === 0) {
      lockPointer(page.game);
    }
  });
  // Browsers may suspend audio until a gesture (autoplay policy, backgrounded tab): resume on the next one.
  for (const type of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(type, () => void room?.audio.resume());
  }
  // "Start a party" changes the URL without a page load; going back or forward loads the page for that URL again.
  window.addEventListener('popstate', () => location.reload());
}

/** For manual checks and e2e tests, in dev builds only. */
function exposeForTests(): void {
  Object.assign(window, {
    __game: {
      map,
      player: you.player,
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
