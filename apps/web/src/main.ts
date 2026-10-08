import { INTERNAL_H, INTERNAL_W, LEVEL1, parseMap, spawnPoint, stepPlayer } from '@zoom3d/shared';
import { startLoop } from './game/loop';
import { layoutStage, watchLayout } from './game/stage';
import { createInput } from './input/keyboard';
import { createFramebuffer } from './renderer/framebuffer';
import { makeTextures } from './renderer/textures';
import { renderWalls } from './renderer/walls';

const PIXEL_PERFECT = new URLSearchParams(location.search).has('pixelperfect');

const stage = document.getElementById('stage') as HTMLDivElement;
const game = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLCanvasElement;
const gameCtx = game.getContext('2d') as CanvasRenderingContext2D;

const map = parseMap(LEVEL1);
const textures = makeTextures(1);
const fb = createFramebuffer(INTERNAL_W, INTERNAL_H);
const image = new ImageData(new Uint8ClampedArray(fb.pixels.buffer as ArrayBuffer), fb.width, fb.height);
const player = spawnPoint(map, Math.random);
const input = createInput(window, document);

const relayout = () => layoutStage(stage, hud, PIXEL_PERFECT);
relayout();
watchLayout(relayout);

game.addEventListener('click', () => game.requestPointerLock());

// Dev-only inspection hook for manual checks and e2e tests.
if (import.meta.env.DEV) Object.assign(window, { __game: { map, player, input } });

startLoop((dt) => {
  const move = input.state();
  player.angle += input.consumeMouseTurn();
  stepPlayer(map, player, move, dt, player);
  renderWalls(fb, map, player, textures);
  gameCtx.putImageData(image, 0, 0);
});
