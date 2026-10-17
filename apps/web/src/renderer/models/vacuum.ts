// The robot vacuum (robot vacuum spec §2, variant C "chunky retro toy"): an orange D shape, flat at the front, with two
// bright eyes on its bumper so you can tell which way it's heading. Model +x is the front.
import { rgb } from '../framebuffer';
import { buildModel, glowing } from '../voxels';

const SKIRT = rgb(0x3c, 0x32, 0x2d);
const BODY = rgb(0xe8, 0x78, 0x28);
const TOP = rgb(0xf5, 0x8c, 0x37);
/** The disc on top and the eyes glow: full colour even in the dark, untouched by lamps and shadows. */
const TOP_CENTRE = glowing(rgb(0xfa, 0xd2, 0x50), 1);
const BUMPER = rgb(0x46, 0x46, 0x4b);
const EYES = glowing(rgb(0xff, 0xff, 0xd2), 1);

/** 14 × 14 × 4 voxels of 0.05 tiles: 0.7 × 0.7 × 0.2 tiles, about a face disc wide and knee-high. */
export const VACUUM_MODEL = buildModel({ x: 14, y: 14, z: 4 }, 0.05, (x, y, z) => {
  const dx = x + 0.5 - 7;
  const dy = y + 0.5 - 7;
  const r = Math.hypot(dx, dy);
  const inside = (dx >= 3 ? Math.abs(dy) < 7 : r < 7) && dx <= 5.5;
  if (!inside) {
    return 0;
  }
  if (z === 0) {
    return SKIRT;
  }
  if (dx > 4.5 && z === 2 && (Math.abs(dy - 2.5) < 1 || Math.abs(dy + 2.5) < 1)) {
    return EYES;
  }
  if (dx > 4.5 && (z === 1 || z === 2)) {
    return BUMPER;
  }
  if (z === 3) {
    return r < 3.2 ? TOP_CENTRE : TOP;
  }
  return BODY;
});
