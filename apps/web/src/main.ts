import {
  INTERNAL_H,
  INTERNAL_W,
  INTERP_DELAY_MS,
  LEVEL1,
  newRoomId,
  parseMap,
  spawnPoint,
  stepPlayer,
} from '@zoom3d/shared';
import { startLoop } from './game/loop';
import { layoutStage, watchLayout } from './game/stage';
import { createInput } from './input/keyboard';
import { createSession, type Session } from './net/session';
import { type AutomapPeer, drawAutomap } from './renderer/automap';
import { createFramebuffer } from './renderer/framebuffer';
import { drawLabels } from './renderer/labels';
import { hexToRgb, renderSprites, type Sprite } from './renderer/sprites';
import { makeTextures } from './renderer/textures';
import { renderWalls } from './renderer/walls';
import { parseRoute } from './ui/route';
import { clearScreen, showJoin, showLanding, showNotice, showRoomBar, showStatus } from './ui/screens';

const PIXEL_PERFECT = new URLSearchParams(location.search).has('pixelperfect');
const NAME_KEY = 'zoom3d.name';

const stage = document.getElementById('stage') as HTMLDivElement;
const game = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLDivElement;
const gameCtx = game.getContext('2d') as CanvasRenderingContext2D;
const hudCtx = hud.getContext('2d') as CanvasRenderingContext2D;

const map = parseMap(LEVEL1);
const textures = makeTextures(1);
const fb = createFramebuffer(INTERNAL_W, INTERNAL_H);
const image = new ImageData(new Uint8ClampedArray(fb.pixels.buffer as ArrayBuffer), fb.width, fb.height);
const player = spawnPoint(map, Math.random);
const input = createInput(window, document);
let session: Session | null = null;

const relayout = () => layoutStage(stage, hud, PIXEL_PERFECT);
relayout();
watchLayout(relayout);

const inRoom = () => session?.status() === 'open';
game.addEventListener('click', () => {
  if (inRoom()) game.requestPointerLock();
});

let automapVisible = false;
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Tab' && e.code !== 'KeyM') return;
  // Outside the room Tab keeps its keyboard-navigation meaning.
  if (!inRoom() || e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  if (!e.repeat) automapVisible = !automapVisible;
});

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
    onJoin(name) {
      saveName(name);
      clearScreen(ui);
      session = createSession({
        url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
        roomId: route.roomId,
        name,
        player,
        now: () => performance.now(),
      });
      showRoomBar(ui, location.href);
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
    },
  });
}

const sprites: Sprite[] = [];
const others: AutomapPeer[] = [];
const sample = { x: 0, y: 0, angle: 0 };
const colors = new Map<string, number>();
let shownStatus: string | null = null;

startLoop((dt) => {
  const mouseTurn = input.consumeMouseTurn();
  if (inRoom()) {
    player.angle += mouseTurn;
    stepPlayer(map, player, input.state(), dt, player);
  }

  sprites.length = 0;
  others.length = 0;
  if (session) {
    const renderTime = performance.now() - INTERP_DELAY_MS;
    for (const peer of session.peers.values()) {
      if (!peer.buffer.sample(renderTime, sample)) continue;
      let color = colors.get(peer.info.color);
      if (color === undefined) {
        color = hexToRgb(peer.info.color);
        colors.set(peer.info.color, color);
      }
      sprites.push({ x: sample.x, y: sample.y, color, face: null });
      others.push({ x: sample.x, y: sample.y, color: peer.info.color, name: peer.info.name });
    }
    const text = statusText(session);
    if (text !== shownStatus) {
      showStatus(ui, text);
      shownStatus = text;
    }
  }

  renderWalls(fb, map, player, textures);
  renderSprites(fb, player, sprites);
  gameCtx.putImageData(image, 0, 0);
  hudCtx.clearRect(0, 0, hud.width, hud.height);
  drawLabels(hudCtx, fb, player, others, hud.width, hud.height);
  if (automapVisible) drawAutomap(hudCtx, map, player, hud.width, hud.height, others);
});
