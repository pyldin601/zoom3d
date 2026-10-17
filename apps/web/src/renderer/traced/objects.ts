// Objects (the robot vacuum) lit by the traced room (spec
// docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md §2): each face direction takes the light the bake
// gives its facing, shown as the traced room shows a mid grey. Pure but for scratch space it reuses, so a light is made
// once per TracedLighting.
import { DIR_BACK, DIR_FRONT, DIR_LEFT, DIR_RIGHT, DIR_TOP } from '../lighting';
import type { VoxelLight } from '../voxels';
import { lampLight, type SurfacePoint } from './bake';
import type { TracedLighting } from './frame';
import { planeLight } from './lightmaps';
import { ENCODE, ENCODE_SIZE, shownPixel } from './tone';

/**
 * A face's colour counts as a mid grey of this linear reflectance, so a multiplier says how much brighter or darker
 * than its authored colour the traced room would show that grey.
 */
const MID_GREY = 0.2;
/** The sRGB byte of linear MID_GREY: the grey as authored. */
const MID_GREY_BYTE = ENCODE.at(Math.round(MID_GREY * (ENCODE_SIZE - 1))) ?? 1;
const CHANNELS = 3;

/** A face direction and its unit normal in model space (+x front, +y right, +z up). */
interface FaceDirection {
  dir: number;
  x: number;
  y: number;
  z: number;
}

const FACE_DIRECTIONS: readonly FaceDirection[] = [
  { dir: DIR_TOP, x: 0, y: 0, z: 1 },
  { dir: DIR_FRONT, x: 1, y: 0, z: 0 },
  { dir: DIR_BACK, x: -1, y: 0, z: 0 },
  { dir: DIR_RIGHT, x: 0, y: 1, z: 0 },
  { dir: DIR_LEFT, x: 0, y: -1, z: 0 },
];

/**
 * A `VoxelLight` for the baked room. Per face direction the irradiance is the lamps' light at the model's mid height,
 * facing that way, plus the floor's bounce light beneath it, the same for every direction. Allocation-free per call.
 */
export function tracedObjectLight({ world, maps }: TracedLighting): VoxelLight {
  const facing: SurfacePoint = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
  const lamps = new Float32Array(CHANNELS);
  const bounce = new Float32Array(CHANNELS);
  return (v, out) => {
    planeLight(maps.floorBounce, world, v.x, v.y, bounce);
    facing.x = v.x;
    facing.y = v.y;
    facing.z = v.model.height / 2;
    const cos = Math.cos(v.angle);
    const sin = Math.sin(v.angle);
    for (const face of FACE_DIRECTIONS) {
      // The model's front (+x) is (cos, sin) on the map and its right (+y) is (-sin, cos).
      facing.nx = face.x * cos - face.y * sin;
      facing.ny = face.x * sin + face.y * cos;
      facing.nz = face.z;
      lampLight(world, facing, lamps);
      for (let channel = 0; channel < CHANNELS; channel++) {
        out[face.dir * CHANNELS + channel] = multiplierUnder((lamps[channel] ?? 0) + (bounce[channel] ?? 0));
      }
    }
  };
}

/** The multiplier on one channel of a face's colour under this irradiance: a mid grey's shown byte over its own. */
function multiplierUnder(irradiance: number): number {
  const radiance = MID_GREY * irradiance;
  return (shownPixel(radiance, radiance, radiance) & 0xff) / MID_GREY_BYTE;
}
