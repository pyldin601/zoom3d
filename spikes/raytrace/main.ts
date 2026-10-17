// The spike's page: walk LEVEL1 with keys, mouse or touch, and switch between the ray-traced renderer and the current
// one. The bake runs a slice per frame, so the ray-traced room fills in while you walk.
import { FOV_WIDE, fitTouchViewport, type MoveInput, type PlayerState, stepPlayer } from '@zoom3d/shared';
import { createFramebuffer, type Framebuffer } from '../../apps/web/src/renderer/framebuffer';
import { bakeRoomLightingOnce } from '../../apps/web/src/renderer/room-lighting';
import { type Room, renderWalls } from '../../apps/web/src/renderer/walls';
import { bake, createLightmaps, type Lightmaps } from './bake';
import { makePeople, stepPeople } from './people';
import { drawPeopleOver, phaseMs, renderTraced, type TraceSettings } from './render';
import { isSolid, makeWorld } from './world';

const BAKE_SLICE_MS = 8;
const PEOPLE = 7;
const TOUCH_MOVE_PX = 60;
const TOUCH_TURN_PER_PX = 0.008;
const MOUSE_TURN_PER_PX = 0.005;

type Mode = 'traced' | 'current';

const touch = matchMedia('(pointer: coarse)').matches;
const world = makeWorld();
const people = makePeople(world, PEOPLE);
const player: PlayerState = startPose();
const settings: TraceSettings = { reflections: true, reflectionScale: 2, exposure: 4 };
let mode: Mode = 'traced';
let wallHeights = 3;
let maps: Lightmaps = createLightmaps(world, wallHeights);
let baking = bake(world, maps);
let bakeDone = false;
let bakeProgress = 0;
let bakeMs = 0;
const currentLighting = bakeRoomLightingOnce(world.map, world.textures, true);
const room: Room = { map: world.map, textures: world.textures, eye: player, lighting: null, reflections: 'both' };

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
let fb: Framebuffer = createFramebuffer(640, 360, FOV_WIDE);
let image = new ImageData(new Uint8ClampedArray(fb.pixels.buffer as ArrayBuffer), fb.width, fb.height);
fitFrame();
addEventListener('resize', fitFrame);

const keys = new Set<string>();
const input: MoveInput = { forward: 0, strafe: 0, turn: 0 };
let dragTurn = 0;
const stick = { id: -1, x: 0, y: 0, dx: 0, dy: 0 };
const turner = { id: -1, x: 0 };
let mouseDrag = -1;
wireInput();
wireControls();

let last = performance.now();
let renderMsAvg = 0;
let frameMsAvg = 16;
let hudAt = 0;
// For poking at it from the console: spike.player.x = …
Object.assign(window, { spike: { player, settings, people, world } });
requestAnimationFrame(tick);

function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  frameMsAvg += ((now - last) - frameMsAvg) * 0.05;
  last = now;
  bakeSlice();
  readMove();
  stepPlayer(world.map, player, input, dt, player);
  player.angle += dragTurn;
  dragTurn = 0;
  stepPeople(world, people, dt);

  const start = performance.now();
  if (mode === 'traced') {
    renderTraced(world, maps, people, player, fb, settings);
  } else {
    room.eye = player;
    room.lighting = currentLighting();
    renderWalls(fb, room);
    drawPeopleOver(world, people, player, fb);
  }
  renderMsAvg += (performance.now() - start - renderMsAvg) * 0.05;
  ctx.putImageData(image, 0, 0);
  if (now - hudAt > 250) {
    hudAt = now;
    showStats();
  }
  requestAnimationFrame(tick);
}

function bakeSlice(): void {
  if (bakeDone) {
    return;
  }
  const start = performance.now();
  while (performance.now() - start < BAKE_SLICE_MS) {
    const step = baking.next();
    if (step.done) {
      bakeDone = true;
      break;
    }
    bakeProgress = step.value;
  }
  bakeMs += performance.now() - start;
}

function rebake(heights: number): void {
  wallHeights = heights;
  maps = createLightmaps(world, wallHeights);
  baking = bake(world, maps);
  bakeDone = false;
  bakeProgress = 0;
  bakeMs = 0;
}

function startPose(): PlayerState {
  const { x, y } = world.map.spawn;
  let best = 0;
  let angle = 0;
  for (let k = 0; k < 4; k++) {
    const dx = Math.round(Math.cos((k * Math.PI) / 2));
    const dy = Math.round(Math.sin((k * Math.PI) / 2));
    let run = 0;
    while (!isSolid(world, x + dx * (run + 1), y + dy * (run + 1))) {
      run++;
    }
    if (run > best) {
      best = run;
      angle = (k * Math.PI) / 2;
    }
  }
  return { x: x + 0.5, y: y + 0.5, angle };
}

function fitFrame(): void {
  const size = touch
    ? fitTouchViewport(innerWidth, innerHeight)
    : { width: 640, height: 360, fov: FOV_WIDE };
  if (size.width === fb.width && size.height === fb.height && size.fov === fb.fov) {
    return;
  }
  fb = createFramebuffer(size.width, size.height, size.fov);
  image = new ImageData(new Uint8ClampedArray(fb.pixels.buffer as ArrayBuffer), fb.width, fb.height);
  canvas.width = fb.width;
  canvas.height = fb.height;
}

// Input: WASD or arrows and a mouse drag on desktop; on touch the left half is a stick, the right half turns.

function readMove(): void {
  const on = (...codes: string[]) => (codes.some((c) => keys.has(c)) ? 1 : 0);
  input.forward = on('KeyW', 'ArrowUp') - on('KeyS', 'ArrowDown') - stick.dy;
  input.strafe = on('KeyD') - on('KeyA') + stick.dx;
  input.turn = on('ArrowRight', 'KeyE') - on('ArrowLeft', 'KeyQ');
}

function wireInput(): void {
  addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'KeyT') {
      setMode(mode === 'traced' ? 'current' : 'traced');
    } else if (e.code === 'KeyR') {
      setReflections(!settings.reflections ? 2 : settings.reflectionScale === 2 ? 4 : 0);
    } else if (e.code === 'KeyH') {
      setHeights(wallHeights === 3 ? 8 : 3);
    }
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  const stage = document.getElementById('stage') as HTMLElement;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') {
      mouseDrag = e.pointerId;
      stage.setPointerCapture(e.pointerId);
    } else if (e.clientX < innerWidth / 2 && stick.id < 0) {
      Object.assign(stick, { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0 });
      stage.setPointerCapture(e.pointerId);
    } else if (turner.id < 0) {
      Object.assign(turner, { id: e.pointerId, x: e.clientX });
      stage.setPointerCapture(e.pointerId);
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerId === mouseDrag) {
      dragTurn += e.movementX * MOUSE_TURN_PER_PX;
    } else if (e.pointerId === stick.id) {
      stick.dx = clampUnit((e.clientX - stick.x) / TOUCH_MOVE_PX);
      stick.dy = clampUnit((e.clientY - stick.y) / TOUCH_MOVE_PX);
    } else if (e.pointerId === turner.id) {
      dragTurn += (e.clientX - turner.x) * TOUCH_TURN_PER_PX;
      turner.x = e.clientX;
    }
  });
  const release = (e: PointerEvent) => {
    if (e.pointerId === mouseDrag) {
      mouseDrag = -1;
    } else if (e.pointerId === stick.id) {
      Object.assign(stick, { id: -1, dx: 0, dy: 0 });
    } else if (e.pointerId === turner.id) {
      turner.id = -1;
    }
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
}

function clampUnit(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

// The panel: renderer, reflections, wall light heights and exposure, plus what each costs.

function wireControls(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    b.addEventListener('click', () => setMode(b.dataset.mode as Mode));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-heights]')) {
    b.addEventListener('click', () => setHeights(Number(b.dataset.heights)));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-reflections]')) {
    b.addEventListener('click', () => setReflections(Number(b.dataset.reflections)));
  }
  button('darker').addEventListener('click', () => setExposure(settings.exposure / 1.25));
  button('brighter').addEventListener('click', () => setExposure(settings.exposure * 1.25));
  for (const el of document.querySelectorAll('.panel')) {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
  document.documentElement.classList.toggle('touch', touch);
  showControls();
}

function button(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

function setMode(next: Mode): void {
  mode = next;
  showControls();
}

/** 0 off, else traced at 1/2 or 1/4 resolution. */
function setReflections(scale: number): void {
  settings.reflections = scale > 0;
  if (scale === 2 || scale === 4) {
    settings.reflectionScale = scale;
  }
  showControls();
}

function setHeights(heights: number): void {
  if (heights !== wallHeights) {
    rebake(heights);
  }
  showControls();
}

function setExposure(exposure: number): void {
  settings.exposure = Math.min(12, Math.max(0.5, exposure));
  showControls();
}

function showControls(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-heights]')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.heights) === wallHeights));
  }
  const shownScale = settings.reflections ? settings.reflectionScale : 0;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-reflections]')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.reflections) === shownScale));
  }
  (document.getElementById('exposure') as HTMLElement).textContent = settings.exposure.toFixed(1);
  for (const el of document.querySelectorAll<HTMLElement>('.traced-only')) {
    el.toggleAttribute('data-off', mode !== 'traced');
  }
}

function showStats(): void {
  const fps = 1000 / frameMsAvg;
  (document.getElementById('cost') as HTMLElement).textContent = `${renderMsAvg.toFixed(1)} ms`;
  (document.getElementById('fps') as HTMLElement).textContent = `${fps.toFixed(0)} fps`;
  (document.getElementById('size') as HTMLElement).textContent = `${fb.width}×${fb.height}`;
  const p = phaseMs;
  (document.getElementById('phases') as HTMLElement).textContent =
    `walls ${p.walls.toFixed(1)} · floor ${p.floor.toFixed(1)} · refl ${p.reflections.toFixed(1)} · out ${p.composite.toFixed(1)}`;
  (document.getElementById('bake') as HTMLElement).textContent = bakeDone
    ? `baked in ${(bakeMs / 1000).toFixed(1)} s`
    : `baking ${(bakeProgress * 100).toFixed(0)}%`;
}
