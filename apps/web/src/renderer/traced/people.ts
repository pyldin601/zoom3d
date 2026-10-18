// The people near the eye as the traced room's reflections see them (spec §3.3): their discs, and their colours in
// linear light, listed once per frame. Allocation-free once sized: the lists grow only when the crowd does.
import { FACE_SIZE } from '../../media/faces';
import { EYE_HEIGHT } from '../camera';
import { averageFace } from '../glow';
import { AVATAR_RADIUS, BOB_HEIGHT, FACE_RADIUS, type Sprite } from '../sprites';
import { type NearbyThings, REACH_TILES } from './along-ray';
import { linearOfSrgbChannel } from './world';

/** A face's linear colour shows in a reflection at this much: about how bright its screen colours look at exposure 4. */
export const FACE_REFLECTION_GAIN = 0.3;

/** Each sRGB byte as a reflection shows it: its linear light times FACE_REFLECTION_GAIN. */
const SHOWN_OF_SRGB = Float32Array.from({ length: 256 }, (_, byte) => linearOfSrgbChannel(byte) * FACE_REFLECTION_GAIN);

/** The people near the eye this frame, in the order listed: their discs, and how each shows in a reflection. */
export interface NearbyPeople extends NearbyThings {
  /** Each disc's centre height (tiles): eye height, lifted by the walking bob. */
  height: Float64Array;
  /** Each person's face, FACE_SIZE² sRGB texels, or null for a flat disc of the ring's colour. */
  face: (Uint32Array | null)[];
  /**
   * Each person's ring colour, and what a blurred view of the disc shows (the face's average, or the ring's colour
   * without one): r, g, b as a reflection shows them.
   */
  ring: Float32Array;
  blurred: Float32Array;
}

/** A colour as a reflection shows it, linear light: reused, so read it before the next call that fills it. */
export interface ShownColour {
  red: number;
  green: number;
  blue: number;
}

export function createNearbyPeople(): NearbyPeople {
  return {
    count: 0,
    x: new Float64Array(0),
    y: new Float64Array(0),
    radius: new Float64Array(0),
    height: new Float64Array(0),
    face: [],
    ring: new Float32Array(0),
    blurred: new Float32Array(0),
  };
}

/** Lists into `out` the people within REACH_TILES of the eye at (eyeX, eyeY), with their colours. */
export function listNearbyPeople(people: readonly Sprite[], eyeX: number, eyeY: number, out: NearbyPeople): void {
  fitNearbyPeople(out, people.length);
  const listedBefore = out.count;
  let count = 0;
  for (const person of people) {
    if ((person.x - eyeX) ** 2 + (person.y - eyeY) ** 2 > REACH_TILES * REACH_TILES) {
      continue;
    }
    out.x[count] = person.x;
    out.y[count] = person.y;
    out.radius[count] = AVATAR_RADIUS;
    out.height[count] = EYE_HEIGHT + person.bob * BOB_HEIGHT * AVATAR_RADIUS;
    out.face[count] = person.face;
    showPacked(person.color, out.ring, count);
    if (person.face) {
      showAverage(averageFace(person.face), out.blurred, count);
    } else {
      showPacked(person.color, out.blurred, count);
    }
    count++;
  }
  out.count = count;
  // Past the list's end a face from an earlier frame would keep the camera frame of someone who has left in memory.
  for (let stale = count; stale < listedBefore; stale++) {
    out.face[stale] = null;
  }
}

/**
 * Where a sharp reflection meets person `person`'s disc at (across, up), in radii from its centre (inside the disc), as
 * the reflection shows it, into `out`: the face's texel out to FACE_RADIUS, the ring beyond it or without a face.
 */
export function seeDiscSharp(people: NearbyPeople, person: number, across: number, up: number, out: ShownColour): void {
  const face = people.face[person];
  if (!face || across * across + up * up >= FACE_RADIUS * FACE_RADIUS) {
    out.red = people.ring[person * 3] ?? 0;
    out.green = people.ring[person * 3 + 1] ?? 0;
    out.blue = people.ring[person * 3 + 2] ?? 0;
    return;
  }
  const texel = face[faceTexelOf(-up) * FACE_SIZE + faceTexelOf(across)] ?? 0;
  out.red = SHOWN_OF_SRGB[texel & 0xff] ?? 0;
  out.green = SHOWN_OF_SRGB[(texel >>> 8) & 0xff] ?? 0;
  out.blue = SHOWN_OF_SRGB[(texel >>> 16) & 0xff] ?? 0;
}

/** The face texel column (or row) `offset` radii from the disc's centre: the face's circle spans the whole texture. */
function faceTexelOf(offset: number): number {
  const texel = ((offset / FACE_RADIUS + 1) * 0.5 * FACE_SIZE) | 0;
  return texel < 0 ? 0 : texel >= FACE_SIZE ? FACE_SIZE - 1 : texel;
}

/** Grows `out`'s lists to hold `people` people, if they can't already. */
function fitNearbyPeople(out: NearbyPeople, people: number): void {
  if (out.x.length >= people) {
    return;
  }
  out.x = new Float64Array(people);
  out.y = new Float64Array(people);
  out.radius = new Float64Array(people);
  out.height = new Float64Array(people);
  out.ring = new Float32Array(people * 3);
  out.blurred = new Float32Array(people * 3);
}

/** A packed sRGB colour (see `rgb`) as a reflection shows it, into person `person`'s r, g, b in `out`. */
function showPacked(packed: number, out: Float32Array, person: number): void {
  out[person * 3] = SHOWN_OF_SRGB[packed & 0xff] ?? 0;
  out[person * 3 + 1] = SHOWN_OF_SRGB[(packed >>> 8) & 0xff] ?? 0;
  out[person * 3 + 2] = SHOWN_OF_SRGB[(packed >>> 16) & 0xff] ?? 0;
}

/** An average sRGB colour, 0..255 per channel, as a reflection shows it, into person `person`'s r, g, b in `out`. */
function showAverage(average: { r: number; g: number; b: number }, out: Float32Array, person: number): void {
  out[person * 3] = SHOWN_OF_SRGB[Math.round(average.r)] ?? 0;
  out[person * 3 + 1] = SHOWN_OF_SRGB[Math.round(average.g)] ?? 0;
  out[person * 3 + 2] = SHOWN_OF_SRGB[Math.round(average.b)] ?? 0;
}
