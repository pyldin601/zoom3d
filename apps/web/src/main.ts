// The page: the landing picture, the lobby, then the room loop. It wires the modules together and owns the page's
// state; what can be pure lives in the modules (the other people in game/remote-world.ts, the room's keys in
// input/room-keys.ts, the drink key in input/drink-key.ts).
import {
  DEFAULT_AUDIO_SETTINGS,
  type HeldItem,
  LEVEL1,
  newRoomId,
  parseMap,
  spawnPoint,
  stepPlayer,
} from '@zoom3d/shared';
import { preferPlayAndRecord } from './audio/audio-session';
import { createDoorbell, withDoorbell } from './audio/doorbell';
import { type AudioEngine, createAudioEngine } from './audio/engine';
import { createObjectSounds, type ObjectSounds } from './audio/object-sounds';
import { HIDDEN_TICK_MS, startHiddenTicker } from './audio/ticker';
import { createFrameRateMeter } from './game/frame-rate';
import { startLoop } from './game/loop';
import { findPageElements, pageStorage, readPageFlags } from './game/page';
import { createRemoteWorld, type PeerMedia } from './game/remote-world';
import { type Frame, layoutStage, watchLayout } from './game/stage';
import { createDrinkKey } from './input/drink-key';
import { createInput } from './input/keyboard';
import { lockPointer } from './input/pointer-lock';
import { type RoomKey, roomKey } from './input/room-keys';
import { createTouchInput } from './input/touch';
import { loadAvatar, saveAvatar } from './media/avatar';
import { type Boombox, createBoombox } from './media/boombox';
import { type Call, createCall } from './media/call';
import { createFace } from './media/faces';
import { createFramer } from './media/framer';
import { createFramingMemory } from './media/framing-memory';
import { createInterest, INTEREST_MS, type PeerFacts, type Want } from './media/interest';
import { createLiveKitTransport } from './media/livekit';
import { createLocalMedia, type LocalMediaController } from './media/local-media';
import { loadMediaPrefs, saveMediaPrefs } from './media/media-prefs';
import { createOwnGlowSampler } from './media/own-glow';
import { createRemoteMedia } from './media/remote-media';
import { createSession, type Session } from './net/session';
import { createBob } from './renderer/bob';
import { type InYourHands, type RoomScene, renderHud, renderView } from './renderer/frame';
import { createFramebuffer, type Framebuffer } from './renderer/framebuffer';
import type { GlowSource } from './renderer/glow';
import { VACUUM_MODEL } from './renderer/models/vacuum';
import { bakeRoomLightingOnce } from './renderer/room-lighting';
import { createGestureClock } from './renderer/sip';
import { ringRgb } from './renderer/sprites';
import { makeTextures } from './renderer/textures';
import type { VoxelInstance } from './renderer/voxels';
import { flushOnHide, initAnalytics, track } from './telemetry/analytics';
import { mediaOutcome } from './telemetry/onboarding';
import { createRoomTracker, type RoomTracker, withRoomTracker } from './telemetry/room-tracker';
import { initSentry } from './telemetry/sentry';
import { setAudioPanelBoombox, showAudioPanel } from './ui/audio-panel';
import type { BoomboxPanelOptions } from './ui/boombox-panel';
import { loadBoomboxVolume, saveBoomboxVolume } from './ui/boombox-store';
import { heldKeyAction, loadHeld, saveHeld } from './ui/held-store';
import { renderLandingScene } from './ui/landing-scene';
import { createLandingShow, LANDING_PARK } from './ui/landing-show';
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
const { game, hud, ui, gameCtx, hudCtx } = page;

const map = parseMap(LEVEL1);
const textures = makeTextures(1);
const roomLighting = bakeRoomLightingOnce(map, textures, flags.lights);
/** The renderer's console options (the lighting mode), kept per browser. */
let renderSettings = loadRenderSettings(pageStorage());
/** Your own disc as a glow source, moved to you each frame. */
const selfDisc = { x: 0, y: 0, face: null, color: 0 };
/** Your face's average colour while the camera is on, null otherwise; set once local media exists. */
let ownGlowColour: (now: number) => number | null = () => null;
let fb: Framebuffer = createFramebuffer();
let image = imageOf(fb);
function imageOf(buffer: Framebuffer): ImageData {
  return new ImageData(new Uint8ClampedArray(buffer.pixels.buffer as ArrayBuffer), buffer.width, buffer.height);
}
/** Counts every drawn room frame and times its drawing; the backtick panel shows the rate and the render time. */
const frameRateMeter = createFrameRateMeter();

// You.

const player = spawnPoint(map, Math.random);
const selfBob = createBob();
const touch = createTouchInput({ surface: game, win: window, doc: document, surfaceWidth: () => game.clientWidth });
const input = createInput(window, document, touch);
/** What the local player holds, drawn in first person. */
let ownHeld: HeldItem | null = null;
/** Whether our boombox is playing, drawn in first person. */
let ownBoombox = false;
/** The local player's sip or cheers, on the performance.now() clock (held items spec §2.3–2.4). */
const ownGesture = createGestureClock();
/** The held drink's key or touch button: a tap sips, a long press cheers (held items spec §2.4). */
const drinkKey = createDrinkKey({
  gesture: ownGesture,
  // Nothing during a reconnect: the others would never see it.
  canGesture: inRoom,
  onGesture(kind) {
    if (kind === 'sip') {
      session?.sendDrink();
    } else {
      session?.sendCheers();
    }
    track({ name: kind });
  },
});

// The room, from Join on.

let session: Session | null = null;
let roomTracker: RoomTracker | null = null;
let call: Call | null = null;
let audio: AudioEngine | null = null;
/** The robot vacuum's hum (and any later object's sound), made when the room is joined. */
let objectSounds: ObjectSounds | null = null;
let boombox: Boombox | null = null;
/** Everyone else and the world objects, as this frame draws them. */
const world = createRemoteWorld();
/** What the world shows of each peer's media. */
const peerMedia: PeerMedia = {
  faceOf: (id) => call?.faceOf(id) ?? null,
  speaking: (id) => audio?.speaking(id) ?? 0,
};

function inRoom(): boolean {
  return session?.status() === 'open';
}

// pagehide, not unload: it fires on mobile and for pages entering the back/forward cache.
window.addEventListener('pagehide', () => {
  roomTracker?.leave();
  flushOnHide();
});

/** The one path for changing the drink in hand, from a number key. */
function chooseHeld(item: HeldItem | null): void {
  if (item === ownHeld) {
    return;
  }
  ownHeld = item;
  drinkKey.cancel();
  refreshTouchControls();
  if (item === null) {
    ownGesture.cancel();
  }
  saveHeld(pageStorage(), item);
  session?.setHeld(item);
  if (item !== null) {
    track({ name: 'drink_picked', item });
  }
}

// The stage: the frame's size follows the window.

/** Whether the frame loop runs; before that the stage shows a still that a new frame size must redraw. */
let looping = false;
let still: { logo: boolean } | null = null;
/** The landing show's robot while the show runs (landing vacuum spec); null once Start a party resets the picture. */
let landingVacuum: VoxelInstance | null = null;
let stopLandingShow: (() => void) | null = null;
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
const relayout = () =>
  rebuildFrame(layoutStage(page.stage, hud, { touch: flags.touch, pixelPerfect: flags.pixelPerfect }));
relayout();
watchLayout(relayout, { skipWhileTyping: flags.touch });

// Mouse-look only: iOS has no pointer lock, and a finger on the view turns by dragging instead (mobile spec §4.1).
game.addEventListener('pointerdown', (e) => {
  if (inRoom() && e.pointerType === 'mouse' && e.button === 0) {
    lockPointer(game);
  }
});

// Browsers may suspend audio until a gesture (autoplay policy, backgrounded tab): resume on the next one.
for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(type, () => void audio?.resume());
}

// The backtick console.

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
      saveBoomboxVolume(pageStorage(), box.volume());
    },
    onSeek: (seconds) => box.seek(seconds),
    onStop: () => box.toggle(true),
  };
}

function toggleAudioPanel(): void {
  audioPanelVisible = !audioPanelVisible;
  if (!audioPanelVisible) {
    showAudioPanel(ui, null);
    return;
  }
  // The panel is worked with the mouse: let go of mouse-look. A click on the view locks it again.
  if (document.pointerLockElement) {
    document.exitPointerLock();
  }
  showAudioPanel(ui, {
    frameRate: frameRateMeter.fps,
    renderLoad: frameRateMeter.renderLoad,
    facesSent: () => call?.sendingFaces() ?? { 256: false, 128: false, 64: false },
    render: {
      settings: renderSettings,
      onChange(s) {
        renderSettings = s;
        saveRenderSettings(pageStorage(), s);
      },
    },
  });
  setAudioPanelBoombox(ui, boomboxControls());
}

// The room's keys; walking is keyboard.ts's.

window.addEventListener('keydown', (e) => {
  // A modifier mid-press means a shortcut, and macOS never reports a key released while Cmd is held: forget the press.
  if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') {
    drinkKey.cancel();
  }
  const key = roomKey(e, { inRoom: inRoom(), hasBoombox: boombox !== null });
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
      toggleAudioPanel();
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
      if (heldKeyAction(key.item, ownHeld) === 'pick') {
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
  boombox?.toggle(inRoom());
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
  touchControls?.update({ held: ownHeld, boombox: ownBoombox, map: automapVisible });
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

function joinRoom(
  roomId: string,
  name: string,
  avatar: string | null,
  local: LocalMediaController,
  audioCtx: AudioContext
): void {
  audio = createAudioEngine({ ctx: audioCtx, map });
  const sounds = createObjectSounds(audioCtx, audio);
  objectSounds = sounds;
  saveName(pageStorage(), name);
  saveAvatar(pageStorage(), avatar);
  clearScreen(ui);
  call = createCall({
    local,
    remote: createRemoteMedia(page.media),
    audio,
    document,
    createFace,
    createTransport: createLiveKitTransport,
  });
  const tracker = createRoomTracker(track, () => performance.now());
  roomTracker = tracker;
  session = createSession({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    roomId,
    name,
    avatar,
    bots: botsParam(location.search),
    player,
    now: () => performance.now(),
    listener: {
      ...withRoomTracker(withDoorbell(call.listener, createDoorbell(audioCtx)), tracker, () => session),
      objectEvent: (id, e) => sounds.event(id, e),
    },
  });
  const held = loadHeld(pageStorage());
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
    container: page.localMedia,
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
  boombox.setVolume(loadBoomboxVolume(pageStorage()));
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
    toggleAudioPanel();
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
    stopLandingShow?.();
    stopLandingShow = null;
    landingVacuum = null;
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
  ownGlowColour = (now) => (camOn ? ownFace.colour(now) : null);
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
      startFrames();
      joinRoom(roomId, name, avatar, local, audioCtx);
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

// Dynamic subscription.

/** Per peer, what the last frame drew of them (written by renderView into reused objects). */
const seen = new Map<string, PeerFacts>();
const interest = createInterest();
/** The wants last handed to `wantsCall`, so only changes are sent. */
const sentWants = new Map<string, Want>();
let wantsCall: Call | null = null;
let interestAt = Number.NEGATIVE_INFINITY;

/** Dynamic subscription (6c spec §4): every INTEREST_MS, decides whose face and voice to receive. */
function chooseWhatToReceive(s: Session, now: number, hidden: boolean): void {
  if (!call || now - interestAt < INTEREST_MS) {
    return;
  }
  interestAt = now;
  if (call !== wantsCall) {
    wantsCall = call;
    sentWants.clear();
  }
  const media = call;
  const { positions } = world;
  for (const id of seen.keys()) {
    if (!positions.has(id)) {
      seen.delete(id);
    }
  }
  const peers: { id: string; x: number; y: number }[] = [];
  for (const [id, pos] of positions) {
    // Bots publish nothing: they must not take anyone's video or voice slot.
    if (s.peers.has(id) && media.publishes(id)) {
      peers.push({ id, x: pos.x, y: pos.y });
    }
  }
  const wants = interest.update({
    now,
    hidden,
    player,
    fov: fb.fov,
    map,
    maxDistance: audio?.settings().max ?? DEFAULT_AUDIO_SETTINGS.max,
    peers,
    facts: (id) => seen.get(id),
  });
  for (const [id, want] of wants) {
    const sent = sentWants.get(id);
    if (!sent || sent.video !== want.video || sent.audio !== want.audio) {
      sentWants.set(id, want);
      media.setWanted(id, want);
    }
  }
  for (const id of sentWants.keys()) {
    if (!wants.has(id)) {
      sentWants.delete(id);
    }
  }
}

// The room loop.

// rAF stops while the tab is hidden: keep voices (and newcomers) audible from a timer meanwhile.
startHiddenTicker(
  () => {
    if (!session) {
      return;
    }
    const now = performance.now();
    world.sample(session, player, now);
    objectSounds?.sync(session.objects, world.objectPoses, HIDDEN_TICK_MS / 1000);
    audio?.update(now, player, world.positions);
    chooseWhatToReceive(session, now, true);
  },
  () => document.hidden
);

function frame(dt: number): void {
  stepSelf(dt);
  const now = performance.now();
  call?.update(now);
  if (session) {
    updateWorld(session, now, dt);
  }
  const drawStart = performance.now();
  const shown = describeScene(drawStart);
  renderView(fb, shown, seen);
  gameCtx.putImageData(image, 0, 0);
  renderHud(hudCtx, fb, shown, automapVisible);
  const drawnAt = performance.now();
  // dt comes from rAF's timestamps, which fall on the screen's refreshes.
  frameRateMeter.frame(drawnAt, dt * 1000, drawnAt - drawStart);
  if (session) {
    chooseWhatToReceive(session, drawnAt, document.hidden);
  }
}

/** Your own move this frame: the mouse or drag turn, keys or pad, and your walking bob. */
function stepSelf(dt: number): void {
  // Consumed outside the room too, so a turn made before it doesn't land on the first frame in it.
  const mouseTurn = input.consumeMouseTurn();
  if (!inRoom()) {
    return;
  }
  player.angle += mouseTurn;
  stepPlayer(map, player, input.state(), dt, player);
  selfBob.update(player.x, player.y, dt);
}

/** Everyone else and the world objects this frame, their sounds, and the room's status line and head count. */
function updateWorld(s: Session, now: number, dt: number): void {
  world.sample(s, player, now);
  world.collect(s, peerMedia, now, dt);
  objectSounds?.sync(s.objects, world.objectPoses, dt);
  setStatus(statusText(s.status(), s.error()));
  // Bots count too: the client can't tell them from people.
  setPeopleCount(s.status() === 'open' ? s.peers.size + 1 : null);
  audio?.update(now, player, world.positions);
}

const yourHands: InYourHands = { drink: null, boombox: false, step: selfBob, gesture: ownGesture.pose(0) };
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
  scene.yourGlow = yourGlow(now);
  scene.inYourHands = inRoom() ? whatYouHold(now) : null;
  return scene;
}

/** Your camera's colour, else your ring's. */
function yourGlow(now: number): GlowSource | null {
  const color = session?.selfColor();
  if (!color) {
    return null;
  }
  selfDisc.x = player.x;
  selfDisc.y = player.y;
  selfDisc.color = ownGlowColour(now) ?? ringRgb(color);
  return selfDisc;
}

function whatYouHold(now: number): InYourHands {
  yourHands.drink = ownHeld;
  yourHands.boombox = ownBoombox;
  yourHands.gesture = ownGesture.pose(now);
  return yourHands;
}

// Stills and the landing show.

/** One still from the renderer: the title picture on the landing page, the same corridor without the title behind
 * the lobby. The room loop starts on Join. */
function showStill(logo: boolean): void {
  still = { logo };
  drawStill(logo);
}

function drawStill(logo: boolean): void {
  renderLandingScene(fb, { logo, lights: flags.lights, vacuum: landingVacuum });
  gameCtx.putImageData(image, 0, 0);
}

/**
 * The landing show (landing vacuum spec §2): the title picture redrawn with the robot vacuum, which comes out after
 * 10 s. Its own small loop, not the room loop, and no input reaches it.
 */
function startLandingShow(): void {
  const show = createLandingShow();
  const vacuum: VoxelInstance = { model: VACUUM_MODEL, ...LANDING_PARK };
  landingVacuum = vacuum;
  /** The buffer last drawn into: a new one (a resize) needs the picture even if the robot stood still. */
  let drawnInto: Framebuffer | null = null;
  stopLandingShow = startLoop((dt) => {
    show.advance(dt);
    // Only the robot moves: while it waits, scans or pauses, the last picture stands.
    if (show.poseInto(vacuum) || drawnInto !== fb) {
      drawnInto = fb;
      drawStill(true);
    }
  });
}

function startFrames(): void {
  looping = true;
  startLoop(frame);
}

if (route.kind === 'invalid') {
  startFrames();
} else {
  showStill(route.kind === 'landing');
  if (route.kind === 'landing' && !flags.reducedMotion) {
    startLandingShow();
  }
}
