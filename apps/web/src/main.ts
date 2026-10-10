import { type HeldItem, INTERP_DELAY_MS, LEVEL1, newRoomId, parseMap, spawnPoint, stepPlayer } from '@zoom3d/shared';
import { preferPlayAndRecord } from './audio/audio-session';
import { createDoorbell, withDoorbell } from './audio/doorbell';
import { type AudioEngine, createAudioEngine } from './audio/engine';
import { loadAudioSettings, saveAudioSettings } from './audio/settings-store';
import { startHiddenTicker } from './audio/ticker';
import { startLoop } from './game/loop';
import { type Frame, layoutStage, watchLayout } from './game/stage';
import { createInput } from './input/keyboard';
import { createTouchInput } from './input/touch';
import { loadAvatar, saveAvatar } from './media/avatar';
import { type Boombox, createBoombox } from './media/boombox';
import { type Call, createCall } from './media/call';
import { createFace } from './media/faces';
import { createFramer } from './media/framer';
import { createFramingMemory } from './media/framing-memory';
import { createLocalMedia, type LocalMediaController } from './media/local-media';
import { loadMediaPrefs, saveMediaPrefs } from './media/media-prefs';
import { createMesh } from './media/mesh';
import { createRemoteMedia } from './media/remote-media';
import { createSession, type Session } from './net/session';
import { type AutomapPeer, drawAutomap } from './renderer/automap';
import { type Bob, createBob } from './renderer/bob';
import { createFramebuffer, type Framebuffer } from './renderer/framebuffer';
import { drawLabels } from './renderer/labels';
import { renderOwnBoombox } from './renderer/own-boombox';
import { renderOwnHeld } from './renderer/own-held';
import { cheersPose, createGestureClock, sipPose } from './renderer/sip';
import { hexToRgb, renderSprites, type Sprite } from './renderer/sprites';
import { makeTextures } from './renderer/textures';
import { renderWalls } from './renderer/walls';
import { flushOnHide, initAnalytics, track } from './telemetry/analytics';
import { mediaOutcome } from './telemetry/onboarding';
import { createRoomTracker, type RoomTracker, withRoomTracker } from './telemetry/room-tracker';
import { initSentry } from './telemetry/sentry';
import { setAudioPanelBoombox, showAudioPanel } from './ui/audio-panel';
import type { BoomboxPanelOptions } from './ui/boombox-panel';
import { loadBoomboxVolume, saveBoomboxVolume } from './ui/boombox-store';
import { CHEERS_HOLD_MS, createDrinkPress } from './ui/drink-press';
import { heldForKey, heldKeyAction, loadHeld, saveHeld } from './ui/held-store';
import { renderLandingScene } from './ui/landing-scene';
import { joinBanner, PROBLEM_TEXT, showLobby } from './ui/lobby';
import { createMicLevel } from './ui/mic-level';
import { parseRoute } from './ui/route';
import {
  clearScreen,
  showBanner,
  showLanding,
  showNotice,
  showRoomBar,
  showSelfPreview,
  showStatus,
} from './ui/screens';
import { showTouchControls, type TouchControls } from './ui/touch-controls';

initSentry(import.meta.env.VITE_SENTRY_DSN, import.meta.env.VITE_RELEASE);
initAnalytics(import.meta.env.VITE_AMPLITUDE_API_KEY, import.meta.env.VITE_RELEASE);

const PIXEL_PERFECT = new URLSearchParams(location.search).has('pixelperfect');
/** Touch mode (mobile spec §2.0): decided once at load, never re-evaluated, so the frame never flips mid-visit. */
const TOUCH = matchMedia('(pointer: coarse)').matches;
document.documentElement.classList.toggle('touch', TOUCH);
const NAME_KEY = 'zoom3d.name';

const stage = document.getElementById('stage') as HTMLDivElement;
const game = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLDivElement;
const mediaContainer = document.getElementById('media') as HTMLDivElement;
const localMediaContainer = document.getElementById('local-media') as HTMLDivElement;
const gameCtx = game.getContext('2d') as CanvasRenderingContext2D;
const hudCtx = hud.getContext('2d') as CanvasRenderingContext2D;

const map = parseMap(LEVEL1);
const textures = makeTextures(1);
let fb: Framebuffer = createFramebuffer();
let image = imageOf(fb);
function imageOf(buffer: Framebuffer): ImageData {
  return new ImageData(new Uint8ClampedArray(buffer.pixels.buffer as ArrayBuffer), buffer.width, buffer.height);
}
const player = spawnPoint(map, Math.random);
const touch = createTouchInput({ surface: game, win: window, doc: document, surfaceWidth: () => game.clientWidth });
const input = createInput(window, document, touch);
let session: Session | null = null;
let roomTracker: RoomTracker | null = null;
// pagehide, not unload: it fires on mobile and for pages entering the back/forward cache.
window.addEventListener('pagehide', () => {
  roomTracker?.leave();
  flushOnHide();
});
/** What the local player holds, drawn in first person. */
let ownHeld: HeldItem | null = null;
/** The local player's sip or cheers, on the performance.now() clock (held items spec §2.3–2.4). */
const ownGesture = createGestureClock();
/** The held drink's key: a tap sips on release, a press held CHEERS_HOLD_MS raises a cheers (spec §2.4). */
const drinkPress = createDrinkPress();
/** The `e.code` of the key being pressed, and the timer that turns a long press into a cheers. */
let pressKey: string | null = null;
let pressTimer: ReturnType<typeof setTimeout> | null = null;
function cancelPress(): void {
  drinkPress.cancel();
  pressKey = null;
  if (pressTimer !== null) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}
/** The one path for changing the drink in hand, from a number key. */
function chooseHeld(item: HeldItem | null): void {
  if (item === ownHeld) {
    return;
  }
  ownHeld = item;
  cancelPress();
  refreshTouchControls();
  if (item === null) {
    ownGesture.cancel();
  }
  saveHeld(storage(), item);
  session?.setHeld(item);
  if (item !== null) {
    track({ name: 'drink_picked', item });
  }
}
let call: Call | null = null;
let audio: AudioEngine | null = null;
let boombox: Boombox | null = null;
/** Whether our boombox is playing, drawn in first person. */
let ownBoombox = false;

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** Whether the frame loop runs; before that the stage shows a still that a new frame size must redraw. */
let looping = false;
let still: { logo: boolean } | null = null;
/** Swaps in a buffer of the new size or FOV; only on rotation or resize, never per frame. */
function rebuildFrame(frame: Frame): void {
  if (frame.width === fb.width && frame.height === fb.height && frame.fov === fb.fov) {
    return;
  }
  fb = createFramebuffer(frame.width, frame.height, frame.fov);
  image = imageOf(fb);
  game.width = fb.width;
  game.height = fb.height;
  if (!looping && still) {
    showStill(still.logo);
  }
}
const relayout = () => rebuildFrame(layoutStage(stage, hud, { touch: TOUCH, pixelPerfect: PIXEL_PERFECT }));
relayout();
watchLayout(relayout, { skipWhileTyping: TOUCH });

const inRoom = () => session?.status() === 'open';
// Mouse-look only: iOS has no pointer lock, and a finger on the view turns by dragging instead (mobile spec §4.1).
game.addEventListener('pointerdown', (e) => {
  if (inRoom() && e.pointerType === 'mouse' && e.button === 0) {
    game.requestPointerLock();
  }
});

// Browsers may suspend audio until a gesture (autoplay policy, backgrounded tab): resume on the next one.
for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(type, () => void audio?.resume());
}

let audioPanelVisible = false;
/** The boombox column of the audio panel, while our boombox plays (boombox spec §3.1). */
function boomboxControls(): BoomboxPanelOptions | null {
  const box = boombox;
  if (!box?.playing()) {
    return null;
  }
  return {
    title: box.title() ?? '',
    volume: box.volume(),
    progress: () => box.progress(),
    onVolume(v) {
      box.setVolume(v);
      saveBoomboxVolume(storage(), box.volume());
    },
    onSeek: (seconds) => box.seek(seconds),
    onStop: () => box.toggle(true),
  };
}

function toggleAudioPanel(): void {
  const engine = audio;
  audioPanelVisible = !audioPanelVisible && engine !== null;
  if (!audioPanelVisible || !engine) {
    showAudioPanel(ui, null);
    return;
  }
  showAudioPanel(ui, {
    settings: engine.settings(),
    onChange(s) {
      engine.setSettings(s);
      saveAudioSettings(storage(), s);
    },
    levels: () =>
      [...(session?.peers.values() ?? [])].map((p) => ({
        name: p.info.name,
        speaking: engine.speaking(p.info.id),
      })),
  });
  setAudioPanelBoombox(ui, boomboxControls());
}
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Backquote' || e.repeat || !inRoom() || e.target instanceof HTMLInputElement) {
    return;
  }
  e.preventDefault();
  toggleAudioPanel();
});

// 1–3 pick a drink, 0 puts it down.
window.addEventListener('keydown', (e) => {
  const item = heldForKey(e.code);
  if (item === undefined || e.repeat || e.metaKey || e.ctrlKey || e.altKey) {
    return;
  }
  if (!inRoom() || e.target instanceof HTMLInputElement) {
    return;
  }
  e.preventDefault();
  if (heldKeyAction(item, ownHeld) === 'pick') {
    chooseHeld(item);
    return;
  }
  beginDrinkPress(e.timeStamp, e.code);
});
window.addEventListener('keyup', (e) => {
  endDrinkPress(e.timeStamp, e.code);
});

/**
 * A press of the held drink, from its number key or the touch drink button (`source`: the key's code, or 'touch'):
 * nothing while a gesture plays, else a sip or a cheers by its length, timed by the input events themselves
 * (`timeStamp`, the performance.now() clock) so a busy main thread can't stretch a tap.
 */
function beginDrinkPress(downAt: number, source: string): void {
  if (ownGesture.kind(performance.now()) !== null || pressKey !== null) {
    return;
  }
  drinkPress.down(downAt);
  pressKey = source;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    // A timer can fire a hair before the clock reads CHEERS_HOLD_MS; it is due either way.
    const now = Math.max(performance.now(), downAt + CHEERS_HOLD_MS);
    if (drinkPress.due(now) === 'cheers') {
      pressKey = null;
      // Like a sip, nothing during a reconnect: the others would never see it.
      if (inRoom() && ownGesture.start('cheers', now)) {
        session?.sendCheers();
        track({ name: 'cheers' });
      }
    }
  }, CHEERS_HOLD_MS);
}

function endDrinkPress(upAt: number, source: string): void {
  if (source !== pressKey) {
    return;
  }
  // A cheers here means the hold timer is running late; the release settles it instead.
  const kind = drinkPress.up(upAt);
  cancelPress();
  const now = performance.now();
  if (kind && inRoom() && ownGesture.start(kind, now)) {
    if (kind === 'sip') {
      session?.sendDrink();
    } else {
      session?.sendCheers();
    }
    track({ name: kind });
  }
}
// A key released in another window never reports keyup here: forget the press.
window.addEventListener('blur', cancelPress);
// Nor does one released while Cmd is held, on macOS; a modifier mid-press means a shortcut anyway.
window.addEventListener('keydown', (e) => {
  if (pressKey !== null && (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt')) {
    cancelPress();
  }
});

// B opens the boombox's file picker, or stops the music (boombox spec §3).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyB' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) {
    return;
  }
  // Stopping works even while reconnecting: the music is local and peers may still hear it.
  if (!boombox || e.target instanceof HTMLInputElement) {
    return;
  }
  e.preventDefault();
  toggleBoombox();
});
function toggleBoombox(): void {
  boombox?.toggle(inRoom());
}

let automapVisible = false;
function toggleAutomap(): void {
  automapVisible = !automapVisible;
  refreshTouchControls();
}
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Tab' && e.code !== 'KeyM') {
    return;
  }
  // Outside the room Tab keeps its keyboard-navigation meaning.
  if (!inRoom() || e.target instanceof HTMLInputElement) {
    return;
  }
  e.preventDefault();
  if (!e.repeat) {
    toggleAutomap();
  }
});

/** The room's touch controls (mobile spec §5): from Join in touch mode, else from the first touch in the room. */
let touchControls: TouchControls | null = null;
function showTouch(): void {
  if (touchControls || !session) {
    return;
  }
  touchControls = showTouchControls(ui, {
    held: ownHeld,
    boombox: ownBoombox,
    map: automapVisible,
    onPick(item) {
      if (inRoom()) {
        chooseHeld(item);
      }
    },
    onDrinkDown: (t) => {
      if (inRoom()) {
        beginDrinkPress(t, 'touch');
      }
    },
    onDrinkUp: (t) => endDrinkPress(t, 'touch'),
    onDrinkCancel: () => {
      if (pressKey === 'touch') {
        cancelPress();
      }
    },
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
  touchControls?.update({ held: ownHeld, boombox: ownBoombox, map: automapVisible });
}
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    showTouch();
  }
});

let shownStatus: string | null = null;
function setStatus(text: string | null): void {
  if (text === shownStatus) {
    return;
  }
  showStatus(ui, text);
  shownStatus = text;
}

function joinRoom(
  roomId: string,
  name: string,
  avatar: string | null,
  local: LocalMediaController,
  audioCtx: AudioContext
): void {
  audio = createAudioEngine({ ctx: audioCtx, map, settings: loadAudioSettings(storage()) });
  saveName(name);
  saveAvatar(storage(), avatar);
  clearScreen(ui);
  call = createCall({
    local,
    remote: createRemoteMedia(mediaContainer),
    audio,
    document,
    createFace,
    createMesh,
  });
  const tracker = createRoomTracker(track, () => performance.now());
  roomTracker = tracker;
  session = createSession({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    roomId,
    name,
    avatar,
    player,
    now: () => performance.now(),
    listener: withRoomTracker(withDoorbell(call.listener, createDoorbell(audioCtx)), tracker, () => session),
  });
  const held = loadHeld(storage());
  ownHeld = held;
  session.setHeld(held);
  session.setBoombox(false);
  call.attach(session);
  const banner = joinBanner(local.state());
  if (banner) {
    showBanner(ui, banner);
  }
  const activeCall = call;
  boombox = createBoombox({
    ctx: audioCtx,
    container: localMediaContainer,
    onTrack: (track) => activeCall.setBoomboxTrack(track),
    onChange(on) {
      if (on) {
        track({ name: 'boombox_started' });
      }
      ownBoombox = on;
      refreshTouchControls();
      session?.setBoombox(on);
      setAudioPanelBoombox(ui, boomboxControls());
    },
  });
  boombox.setVolume(loadBoomboxVolume(storage()));
  const media = local.state();
  showRoomBar(
    ui,
    location.href,
    {
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
    },
    { compact: TOUCH }
  );
  showSelfPreview(ui, local.stream, { cam: media.cam, name, avatar });
  if (TOUCH) {
    showTouch();
  }
  if (new URLSearchParams(location.search).has('debug')) {
    toggleAudioPanel();
  }
}

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Storage unavailable (private mode): the name just isn't remembered.
  }
}

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
    history.pushState(null, '', `/r/${roomId}`);
    showStill(false);
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
      framer: createFramer({ container: localMediaContainer, document, memory: createFramingMemory(storage()) }),
    },
    loadMediaPrefs(storage())
  );
  track({ name: 'lobby_viewed', entry: roomId === hostedRoom ? 'host' : 'invite' });
  void local.ready.then(() => track({ name: 'media_permission', ...mediaOutcome(local.state()) }));
  // Saved for the whole visit, so the room's Cam/Mic buttons are remembered too.
  local.subscribe(() => saveMediaPrefs(storage(), local.prefs()));
  const meter = createMicLevel(audioCtx);
  meter.setTrack(local.micTrack());
  const stopMetering = local.subscribe(() => meter.setTrack(local.micTrack()));
  const closeLobby = showLobby(ui, {
    media: local,
    defaultName: loadName(),
    defaultAvatar: loadAvatar(storage()),
    level: meter.level,
    onJoin(name, avatar) {
      // Resumed synchronously inside the Join click (user gesture), before anything else.
      void audioCtx.resume();
      closeLobby();
      stopMetering();
      meter.dispose();
      startFrames();
      joinRoom(roomId, name, avatar, local, audioCtx);
    },
  });
}

function statusText(s: Session): string | null {
  switch (s.status()) {
    case 'open':
      return null;
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'failed':
      return s.error() === 'room_full' ? 'This room is full (8 people)' : "Couldn't join this room";
  }
}

// Dev-only inspection hook for manual checks and e2e tests.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __game: {
      map,
      player,
      input,
      get session() {
        return session;
      },
      get call() {
        return call;
      },
      get audio() {
        return audio;
      },
    },
  });
}

const sprites: Sprite[] = [];
const others: (AutomapPeer & { mic: boolean })[] = [];
const sample = { x: 0, y: 0, angle: 0 };
const colors = new Map<string, number>();
const positions = new Map<string, { x: number; y: number }>();
const selfBob = createBob();
const peerBobs = new Map<string, Bob>();

/** Samples every peer's interpolated position into `positions` (reused objects). */
function refreshPositions(s: Session, now: number): void {
  const renderTime = now - INTERP_DELAY_MS;
  for (const id of positions.keys()) {
    if (!s.peers.has(id)) {
      positions.delete(id);
    }
  }
  for (const peer of s.peers.values()) {
    if (!peer.buffer.sample(renderTime, sample)) {
      continue;
    }
    const pos = positions.get(peer.info.id);
    if (pos) {
      pos.x = sample.x;
      pos.y = sample.y;
    } else {
      positions.set(peer.info.id, { x: sample.x, y: sample.y });
    }
  }
}

// rAF stops while the tab is hidden: keep voices (and newcomers) audible from a timer meanwhile.
startHiddenTicker(
  () => {
    if (!session || !audio) {
      return;
    }
    const now = performance.now();
    refreshPositions(session, now);
    audio.update(now, player, positions);
  },
  () => document.hidden
);

function frame(dt: number): void {
  const mouseTurn = input.consumeMouseTurn();
  if (inRoom()) {
    player.angle += mouseTurn;
    stepPlayer(map, player, input.state(), dt, player);
    selfBob.update(player.x, player.y, dt);
  }

  sprites.length = 0;
  others.length = 0;
  call?.update(performance.now());
  if (session) {
    const now = performance.now();
    refreshPositions(session, now);
    for (const id of peerBobs.keys()) {
      if (!positions.has(id)) {
        peerBobs.delete(id);
      }
    }
    for (const peer of session.peers.values()) {
      const pos = positions.get(peer.info.id);
      if (!pos) {
        continue;
      }
      let bob = peerBobs.get(peer.info.id);
      if (!bob) {
        bob = createBob();
        peerBobs.set(peer.info.id, bob);
      }
      bob.update(pos.x, pos.y, dt);
      let color = colors.get(peer.info.color);
      if (color === undefined) {
        color = hexToRgb(peer.info.color);
        colors.set(peer.info.color, color);
      }
      const gesture = peer.gesture;
      // cheersPose returns a reused object: read it before the next call.
      const raised = gesture?.kind === 'cheers' ? cheersPose(now - gesture.at) : null;
      sprites.push({
        x: pos.x,
        y: pos.y,
        color,
        face: call?.faceOf(peer.info.id) ?? null,
        speaking: audio?.speaking(peer.info.id) ?? 0,
        bob: bob.lift,
        itemBob: bob.itemLift,
        sip: gesture?.kind === 'sip' ? sipPose(now - gesture.at) : 0,
        cheers: raised ? raised.lift : 0,
        wobble: raised ? raised.wobble : 0,
        held: peer.info.held,
        boombox: peer.info.boombox,
      });
      others.push({
        x: pos.x,
        y: pos.y,
        color: peer.info.color,
        name: peer.info.name,
        mic: peer.info.mic,
      });
    }
    setStatus(statusText(session));
    audio?.update(now, player, positions);
  }

  renderWalls(fb, map, player, textures);
  renderSprites(fb, player, sprites);
  if (inRoom()) {
    renderOwnHeld(fb, ownHeld, selfBob.itemLift, selfBob.sway, ownGesture.pose(performance.now()));
    renderOwnBoombox(fb, ownBoombox, selfBob.itemLift, selfBob.sway);
  }
  gameCtx.putImageData(image, 0, 0);
  hudCtx.clearRect(0, 0, hud.width, hud.height);
  drawLabels(hudCtx, fb, player, others, hud.width, hud.height);
  if (automapVisible) {
    drawAutomap(hudCtx, map, player, hud.width, hud.height, others);
  }
}

/** One still from the renderer: the title picture on the landing page, the same corridor without the title behind
 * the lobby. The room loop starts on Join. */
function showStill(logo: boolean): void {
  still = { logo };
  renderLandingScene(fb, { logo });
  gameCtx.putImageData(image, 0, 0);
}

function startFrames(): void {
  looping = true;
  startLoop(frame);
}

if (route.kind === 'invalid') {
  startFrames();
} else {
  showStill(route.kind === 'landing');
}
