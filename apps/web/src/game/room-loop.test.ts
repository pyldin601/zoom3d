import { parseMap } from '@zoom3d/shared';
import { describe, expect, test, vi } from 'vitest';
import { createFramebuffer, type Framebuffer } from '../renderer/framebuffer';
import type { Lighting } from '../renderer/lighting';
import { bakeRoomLightingOnce } from '../renderer/room-lighting';
import { firstDifference } from '../renderer/test-helpers';
import { makeTextures } from '../renderer/textures';
import { renderTraced, type TracedLighting } from '../renderer/traced/frame';
import { BAKE_SLICE_MS, createTracedRoom, type TracedRoom } from '../renderer/traced/room';
import { renderWalls } from '../renderer/walls';
import { RENDER_MODES, type RenderMode } from '../ui/render-settings';
import { createLocalPlayer } from './local-player';
import { createRoomLoop } from './room-loop';

/** A 3 x 7 corridor: long enough for corridorLights to hang lamps in it. */
const CORRIDOR = `
11111
1S..1
1...1
1...1
1...1
1...1
1...1
1...1
11111`;

const MAP = parseMap(CORRIDOR);
const TEXTURES = makeTextures(1);
const FRAME_SECONDS = 1 / 60;
const NO_END = Number.POSITIVE_INFINITY;
const OTHER_MODES = RENDER_MODES.filter((mode) => mode !== 'traced');
/** Canvas calls are no-ops: with nobody in the room the HUD draws nothing. */
const HUD = new Proxy({}, { get: (_target, name) => (name === 'canvas' ? { width: 64, height: 36 } : () => {}) });

const litLighting = bakeRoomLightingOnce(MAP, TEXTURES, true);

function bakedTracedRoom(): TracedRoom {
  const room = createTracedRoom(MAP, TEXTURES, true);
  room.bake(NO_END);
  return room;
}

/** A traced room that is never ready, and counts the bake calls the loop makes. */
function unfinishedTracedRoom() {
  const bake = vi.fn<(budgetMs: number) => void>();
  const room: TracedRoom = { bake, lighting: () => null };
  return { room, bake };
}

function tracedLightingOf(room: TracedRoom): TracedLighting {
  const lighting = room.lighting();
  if (!lighting) {
    throw new Error('the bake has not finished');
  }
  return lighting;
}

/** The room loop with nobody in the room, drawing into a small frame; `mode` can change between frames. */
function roomLoop(tracedRoom: TracedRoom, lighting: () => Lighting | null = litLighting) {
  const fb = createFramebuffer(64, 36);
  const localPlayer = createLocalPlayer(MAP, () => 0.5);
  let mode: RenderMode = 'traced';
  const loop = createRoomLoop({
    map: MAP,
    textures: TEXTURES,
    localPlayer,
    input: { state: () => ({ forward: 0, strafe: 0, turn: 0 }), consumeMouseTurn: () => 0, reset() {} },
    screen: { fb, present() {}, showTitle() {}, showLobbyPicture() {}, runRoom() {} },
    hud: HUD as CanvasRenderingContext2D,
    frameRate: { frame() {}, fps: () => null, renderLoad: () => null },
    statusLine: { show() {} },
    room: () => null,
    renderMode: () => mode,
    roomLighting: lighting,
    tracedRoom,
    showMap: () => false,
  });
  return {
    fb,
    eye: localPlayer.pose,
    frameIn(shownMode: RenderMode) {
      mode = shownMode;
      loop.frame(FRAME_SECONDS);
    },
  };
}

/** What the lit renderer draws for the loop's frame. */
function litFrame(eye: { x: number; y: number; angle: number }, lighting: Lighting | null): Framebuffer {
  const fb = createFramebuffer(64, 36);
  renderWalls(fb, { map: MAP, textures: TEXTURES, eye, lighting, reflections: 'both' }, []);
  return fb;
}

/** What the traced renderer draws for the loop's frame. */
function tracedFrame(eye: { x: number; y: number; angle: number }, traced: TracedLighting): Framebuffer {
  const fb = createFramebuffer(64, 36);
  renderTraced(fb, { map: MAP, eye, people: [], traced });
  return fb;
}

describe('the room loop, baking the traced room', () => {
  test('bakes a slice each frame while the mode is traced', () => {
    const { room, bake } = unfinishedTracedRoom();
    const { frameIn } = roomLoop(room);
    frameIn('traced');
    frameIn('traced');
    frameIn('traced');
    expect(bake.mock.calls).toEqual([[BAKE_SLICE_MS], [BAKE_SLICE_MS], [BAKE_SLICE_MS]]);
  });

  test.each(OTHER_MODES)('leaves the bake alone in the %s mode', (mode) => {
    const { room, bake } = unfinishedTracedRoom();
    roomLoop(room).frameIn(mode);
    expect(bake).not.toHaveBeenCalled();
  });
});

describe('the room loop, drawing the room', () => {
  test('draws the lit room until the traced one is baked', () => {
    const { room } = unfinishedTracedRoom();
    const { fb, eye, frameIn } = roomLoop(room);
    frameIn('traced');
    expect(firstDifference(fb.pixels, litFrame(eye, litLighting()).pixels)).toBe(-1);
  });

  test('draws the traced room once it is baked', () => {
    const room = bakedTracedRoom();
    const { fb, eye, frameIn } = roomLoop(room);
    frameIn('traced');
    const traced = tracedFrame(eye, tracedLightingOf(room));
    expect(firstDifference(fb.pixels, traced.pixels)).toBe(-1);
    expect(firstDifference(fb.pixels, litFrame(eye, litLighting()).pixels)).toBeGreaterThanOrEqual(0);
  });

  test('draws the lit room again when the mode leaves traced', () => {
    const { fb, eye, frameIn } = roomLoop(bakedTracedRoom());
    frameIn('traced');
    frameIn('reflections');
    expect(firstDifference(fb.pixels, litFrame(eye, litLighting()).pixels)).toBe(-1);
  });

  test('draws the flat room in the traced mode with the lights off', () => {
    const lightsOff = createTracedRoom(MAP, TEXTURES, false);
    const { fb, eye, frameIn } = roomLoop(lightsOff, () => null);
    frameIn('traced');
    expect(lightsOff.lighting()).toBeNull();
    expect(firstDifference(fb.pixels, litFrame(eye, null).pixels)).toBe(-1);
  });
});
