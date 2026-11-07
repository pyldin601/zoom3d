// A kick scooter (kick scooter spec §4.3): two small wheels, a low deck, and a stem at the front with a handlebar
// across it. Model +x is the front. Drawn parked, and under a rider who stands on its deck.
import { rgb } from '../framebuffer';
import { buildModel } from '../voxels';

const WHEEL = rgb(0x22, 0x22, 0x26);
const DECK = rgb(0x1f, 0xa8, 0x9b);
const STEM = rgb(0xb4, 0xb9, 0xc0);
const GRIP = rgb(0x30, 0x30, 0x34);

const VOXEL_TILES = 0.05;
/** The deck's top above the floor, in tiles: how high a rider stands. */
export const SCOOTER_DECK_TILES = 2 * VOXEL_TILES;

const LENGTH = 12;
const WIDTH = 4;
const HEIGHT = 11;
const STEM_X = LENGTH - 2;

/** 12 × 4 × 11 voxels of 0.05 tiles: 0.6 tiles long and 0.55 tall to the handlebar. */
export const SCOOTER_MODEL = buildModel({ x: LENGTH, y: WIDTH, z: HEIGHT }, VOXEL_TILES, (x, y, z) => {
  const middle = y === 1 || y === 2;
  const wheel = (x <= 1 || x >= LENGTH - 2) && z <= 1;
  if (middle && wheel) {
    return WHEEL;
  }
  if (middle && z === 1 && x >= 2 && x <= STEM_X - 1) {
    return DECK;
  }
  if (x === STEM_X && middle && z >= 2 && z < HEIGHT - 1) {
    return STEM;
  }
  if (x === STEM_X && z === HEIGHT - 1) {
    return middle ? STEM : GRIP;
  }
  return 0;
});
