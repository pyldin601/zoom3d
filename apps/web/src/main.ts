import {
  type HeldItem,
  INTERNAL_H,
  INTERNAL_W,
  INTERP_DELAY_MS,
  LEVEL1,
  newRoomId,
  parseMap,
  spawnPoint,
  stepPlayer,
} from '@zoom3d/shared';
import { type AudioEngine, createAudioEngine } from './audio/engine';
import { loadAudioSettings, saveAudioSettings } from './audio/settings-store';
import { startHiddenTicker } from './audio/ticker';
import { startLoop } from './game/loop';
import { layoutStage, watchLayout } from './game/stage';
import { createInput } from './input/keyboard';
import { loadAvatar, saveAvatar } from './media/avatar';
import { type Boombox, createBoombox } from './media/boombox';
import { type Call, createCall } from './media/call';
import { captureLocalMedia, type LocalMedia } from './media/capture';
import { createFace } from './media/faces';
import { createFramer } from './media/framer';
import { createMesh } from './media/mesh';
import { createRemoteMedia } from './media/remote-media';
import { createSession, type Session } from './net/session';
import { type AutomapPeer, drawAutomap } from './renderer/automap';
import { type Bob, createBob } from './renderer/bob';
import { createFramebuffer } from './renderer/framebuffer';
import { drawLabels } from './renderer/labels';
import { renderOwnBoombox } from './renderer/own-boombox';
import { renderOwnHeld } from './renderer/own-held';
import { createSipClock, sipPose } from './renderer/sip';
import { hexToRgb, renderSprites, type Sprite } from './renderer/sprites';
import { makeTextures } from './renderer/textures';
import { renderWalls } from './renderer/walls';
import { showAudioPanel } from './ui/audio-panel';
import { heldForKey, heldKeyAction, loadHeld, saveHeld } from './ui/held-store';
import { parseRoute } from './ui/route';
import {
  clearScreen,
  showBanner,
  showJoin,
  showLanding,
  showNotice,
  showRoomBar,
  showSelfPreview,
  showStatus,
} from './ui/screens';

const PIXEL_PERFECT = new URLSearchParams(location.search).has('pixelperfect');
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
const fb = createFramebuffer(INTERNAL_W, INTERNAL_H);
const image = new ImageData(new Uint8ClampedArray(fb.pixels.buffer as ArrayBuffer), fb.width, fb.height);
const player = spawnPoint(map, Math.random);
const input = createInput(window, document);
let session: Session | null = null;
/** What the local player holds, drawn in first person. */
let ownHeld: HeldItem | null = null;
/** The local player's sip, on the performance.now() clock (held items spec §2.3). */
const ownSip = createSipClock();
/** The one path for changing the drink in hand, from a number key. */
function chooseHeld(item: HeldItem | null): void {
  if (item === ownHeld) {
    return;
  }
  ownHeld = item;
  if (item === null) {
    ownSip.cancel();
  }
  saveHeld(storage(), item);
  session?.setHeld(item);
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

const relayout = () => layoutStage(stage, hud, PIXEL_PERFECT);
relayout();
watchLayout(relayout);

const inRoom = () => session?.status() === 'open';
game.addEventListener('click', () => {
  if (inRoom()) {
    game.requestPointerLock();
  }
});

// Browsers may suspend audio until a gesture (autoplay policy, backgrounded tab): resume on the next one.
for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(type, () => void audio?.resume());
}

let audioPanelVisible = false;
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
  } else if (ownSip.start(performance.now())) {
    session?.sendDrink();
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
  boombox.toggle(inRoom());
});

let automapVisible = false;
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
    automapVisible = !automapVisible;
  }
});

const PROBLEM_TEXT: Record<NonNullable<LocalMedia['problem']>, string> = {
  insecure: 'Camera and mic need HTTPS — joined without them.',
  'no-camera': 'Camera unavailable — others see your picture or initials.',
  'no-mic': 'Microphone unavailable — you can listen only.',
  'none-available': 'Camera and mic unavailable — others see your picture or initials, you can listen only.',
};

let shownStatus: string | null = null;
function setStatus(text: string | null): void {
  if (text === shownStatus) {
    return;
  }
  showStatus(ui, text);
  shownStatus = text;
}

async function joinRoom(roomId: string, name: string, avatar: string | null): Promise<void> {
  // Created and resumed synchronously inside the Join click (user gesture), before any await.
  const audioCtx = new AudioContext({ latencyHint: 'interactive' });
  void audioCtx.resume();
  audio = createAudioEngine({ ctx: audioCtx, map, settings: loadAudioSettings(storage()) });
  saveName(name);
  saveAvatar(storage(), avatar);
  clearScreen(ui);
  setStatus('Starting camera…');
  // Runs from the Join click, so the camera prompt and later autoplay have a user gesture.
  const local = await captureLocalMedia({
    isSecureContext: window.isSecureContext,
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    frame: (raw) => createFramer({ rawTrack: raw, container: localMediaContainer, document }),
  });
  call = createCall({
    local,
    remote: createRemoteMedia(mediaContainer),
    audio,
    document,
    createFace,
    createMesh,
  });
  session = createSession({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    roomId,
    name,
    avatar,
    player,
    now: () => performance.now(),
    listener: call.listener,
  });
  const held = loadHeld(storage());
  ownHeld = held;
  session.setHeld(held);
  session.setBoombox(false);
  call.attach(session);
  if (local.problem) {
    showBanner(ui, PROBLEM_TEXT[local.problem]);
  }
  const activeCall = call;
  boombox = createBoombox({
    ctx: audioCtx,
    container: localMediaContainer,
    onTrack: (track) => activeCall.setBoomboxTrack(track),
    onChange(on) {
      ownBoombox = on;
      session?.setBoombox(on);
    },
  });
  showRoomBar(ui, location.href, {
    cam: local.cam,
    mic: local.mic,
    camAvailable: local.cam,
    micAvailable: local.mic,
    onCam(on) {
      activeCall.setCam(on);
      showSelfPreview(ui, local.stream, activeCall.localState().cam);
    },
    onMic: (on) => activeCall.setMic(on),
  });
  showSelfPreview(ui, local.stream, local.cam);
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
if (route.kind === 'landing') {
  showLanding(ui, () => {
    location.assign(`/r/${newRoomId(crypto.getRandomValues(new Uint8Array(16)))}`);
  });
} else if (route.kind === 'invalid') {
  showNotice(ui, 'Bad room link', 'Start a new room', '/');
} else {
  showJoin(ui, {
    defaultName: loadName(),
    defaultAvatar: loadAvatar(storage()),
    onJoin(name, avatar) {
      void joinRoom(route.roomId, name, avatar);
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

startLoop((dt) => {
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
      sprites.push({
        x: pos.x,
        y: pos.y,
        color,
        face: call?.faceOf(peer.info.id) ?? null,
        speaking: audio?.speaking(peer.info.id) ?? 0,
        bob: bob.lift,
        itemBob: bob.itemLift,
        sip: sipPose(now - peer.drinkAt),
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
    renderOwnHeld(fb, ownHeld, selfBob.itemLift, selfBob.sway, ownSip.pose(performance.now()));
    renderOwnBoombox(fb, ownBoombox, selfBob.itemLift, selfBob.sway);
  }
  gameCtx.putImageData(image, 0, 0);
  hudCtx.clearRect(0, 0, hud.width, hud.height);
  drawLabels(hudCtx, fb, player, others, hud.width, hud.height);
  if (automapVisible) {
    drawAutomap(hudCtx, map, player, hud.width, hud.height, others);
  }
});
