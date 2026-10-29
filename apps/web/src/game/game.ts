// The game: the landing picture, then the lobby, then the room. createGame makes its parts once per page and wires
// them together; each part is its own module.
import { type HeldItem, LEVEL1, newRoomId, parseMap } from '@zoom3d/shared';
import { startHiddenTicker } from '../audio/ticker';
import { createDrinkKey } from '../input/drink-key';
import { createInput } from '../input/keyboard';
import { lockPointer } from '../input/pointer-lock';
import { createTouchInput } from '../input/touch';
import { saveAvatar } from '../media/avatar';
import { NO_FACES_SENT } from '../media/transport';
import { bakeRoomLightingOnce } from '../renderer/room-lighting';
import type { Gesture } from '../renderer/sip';
import { makeTextures } from '../renderer/textures';
import { flushOnHide, track } from '../telemetry/analytics';
import { createBacktickConsole } from '../ui/backtick-console';
import { loadBoomboxVolume, saveBoomboxVolume } from '../ui/boombox-store';
import { loadHeld, saveHeld } from '../ui/held-store';
import { saveName } from '../ui/name-store';
import { showPortalNotice } from '../ui/portal-notice';
import { loadRenderSettings, type RenderMode, saveRenderSettings } from '../ui/render-settings';
import { showRoomScreen } from '../ui/room-screen';
import { createStatusLine } from '../ui/room-status';
import { botsParam, type Route } from '../ui/route';
import { clearScreen, showLanding, showNotice } from '../ui/screens';
import { createFrameRateMeter } from './frame-rate';
import { type LobbyJoin, openLobby } from './lobby-flow';
import { createLocalPlayer } from './local-player';
import { type PageElements, type PageFlags, pageStorage } from './page';
import { isConnected, joinRoom, type Room } from './room';
import { createRoomControls } from './room-controls';
import { createRoomLoop } from './room-loop';
import { createScreen } from './screen';

export interface Game {
  /** Shows what the page's URL asks for: the landing page, a room's lobby, or a bad link. */
  show(route: Route): void;
  /** What manual checks and e2e tests read, as window.__game in dev builds. */
  readonly forTests: object;
}

export function createGame(page: PageElements, flags: PageFlags): Game {
  const map = parseMap(LEVEL1);
  const textures = makeTextures(1);
  const roomLighting = bakeRoomLightingOnce(map, textures, flags.lights);
  const screen = createScreen(page, flags);
  const frameRateMeter = createFrameRateMeter();
  /** The lighting mode, chosen in the backtick console or the touch tray and kept per browser. */
  let renderSettings = loadRenderSettings(pageStorage());

  const localPlayer = createLocalPlayer(map, Math.random);
  const touch = createTouchInput({
    surface: page.game,
    win: window,
    doc: document,
    surfaceWidth: () => page.game.clientWidth,
  });
  const input = createInput(window, document, touch);
  const drinkKey = createDrinkKey({ gesture: localPlayer.gesture, canGesture: inRoom, onGesture: sendGesture });

  let room: Room | null = null;
  const backtickConsole = createBacktickConsole(page.ui, {
    panel: () => ({
      frameRate: frameRateMeter.fps,
      renderLoad: frameRateMeter.renderLoad,
      facesSent: () => room?.call.sendingFaces() ?? NO_FACES_SENT,
      render: {
        settings: renderSettings,
        onChange(s) {
          setRenderMode(s.mode);
          controls.refresh();
        },
      },
    }),
    boombox: () => room?.boombox ?? null,
    saveBoomboxVolume: (volume) => saveBoomboxVolume(pageStorage(), volume),
  });
  const controls = createRoomControls({
    ui: page.ui,
    touch,
    localPlayer,
    drinkKey,
    room: () => room,
    chooseDrink,
    toggleConsole: () => backtickConsole.toggle(),
    renderMode: () => renderSettings.mode,
    setRenderMode,
  });
  const roomLoop = createRoomLoop({
    map,
    textures,
    localPlayer,
    input,
    screen,
    hud: page.hudCtx,
    frameRate: frameRateMeter,
    statusLine: createStatusLine(page.ui),
    room: () => room,
    renderMode: () => renderSettings.mode,
    roomLighting,
    showMap: () => controls.mapShown,
    ballInReach: (inReach) => controls.setKickInReach(inReach),
  });
  // rAF stops while the tab is hidden: keep voices (and newcomers) audible from a timer meanwhile.
  startHiddenTicker(roomLoop.whileHidden, () => document.hidden);
  listenToThePage();

  return {
    show,
    forTests: {
      map,
      player: localPlayer.pose,
      input,
      get session() {
        return room?.session ?? null;
      },
      /** The ball as this client predicts it. */
      get ball() {
        return room?.ball.ball ?? null;
      },
      get call() {
        return room?.call ?? null;
      },
      get audio() {
        return room?.audio ?? null;
      },
      /** Whether the room's portals are on, as this client sees it. */
      get portalsOn() {
        return room?.portals() !== null && room !== null;
      },
    },
  };

  function show(route: Route): void {
    switch (route.kind) {
      case 'landing':
        track({ name: 'landing_viewed' });
        showLanding(page.ui, startParty, import.meta.env.VITE_RELEASE);
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
    openLobby({ page, localPlayer, entry, onJoin: (join) => enterRoom(roomId, join) });
  }

  function enterRoom(roomId: string, { name, avatar, local, audioCtx }: LobbyJoin): void {
    screen.runRoom(roomLoop.frame);
    saveName(pageStorage(), name);
    saveAvatar(pageStorage(), avatar);
    clearScreen(page.ui);
    localPlayer.takeDrink(loadHeld(pageStorage()));
    room = joinRoom({
      roomId,
      name,
      avatar,
      local,
      audioCtx,
      map,
      player: localPlayer.pose,
      mediaContainer: page.media,
      localMediaContainer: page.localMedia,
      drink: localPlayer.drink,
      boomboxVolume: loadBoomboxVolume(pageStorage()),
      onBoomboxChange(on) {
        localPlayer.boombox = on;
        controls.refresh();
        backtickConsole.refreshBoombox();
      },
      onPortalsChanged: (on) => showPortalNotice(page.ui, on),
      lighting: roomLighting,
    });
    showRoomScreen(page.ui, { call: room.call, local, name, avatar });
    if (flags.touch) {
      controls.showTouchControls();
    }
    if (new URLSearchParams(location.search).has('debug')) {
      backtickConsole.toggle();
    }
  }

  function inRoom(): boolean {
    return isConnected(room);
  }

  /** The one path for changing the lighting mode, from the backtick console or the touch tray. */
  function setRenderMode(mode: RenderMode): void {
    renderSettings = { ...renderSettings, mode };
    saveRenderSettings(pageStorage(), renderSettings);
  }

  /** The one path for changing the drink in hand, from a number key or the touch tray. */
  function chooseDrink(item: HeldItem | null): void {
    if (!localPlayer.takeDrink(item)) {
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
}
