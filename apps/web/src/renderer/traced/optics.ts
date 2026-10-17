// How light meets a surface seen at a slant, and how a round thing shows through a reflection cone (spec §3.3). Pure.
import type { TracedMaterial } from './world';

/** A blob is cut off where its falloff passes this: sqrt(18) deviations of a Gaussian, where e^-9 of its peak is left. */
const BLOB_MAX_FALLOFF = 9;

/**
 * Schlick's Fresnel: the share of light a surface reflects, `f0` face-on rising to grazing, where a rough surface is
 * held down (it never turns into a mirror). `cos` is the angle between the view and the surface normal, clamped to 0..1.
 */
export function fresnel(cos: number, material: TracedMaterial): number {
  const grazing = 1 - Math.min(1, Math.max(0, cos));
  const grazing2 = grazing * grazing;
  const mostReflected = Math.max(1 - material.roughness, material.f0);
  return material.f0 + (mostReflected - material.f0) * grazing2 * grazing2 * grazing;
}

/**
 * How much of a round thing (a person, a lamp's disc) a reflection cone sees at one point of the view, 0..1: the thing
 * blurred by the cone as a Gaussian blob, as bright overall as the thing itself (its area, pi r squared) until a cone
 * narrower than the thing would make it brighter than the thing, when its peak stops at 1.
 *
 * `across` and `up` are the offsets from the thing's centre (tiles, in the view's two axes), `spreadAcross` and
 * `spreadUp` how wide the cone is along each; a thing alone is a Gaussian of deviation radius / 2.
 */
export function blobWeight(across: number, up: number, radius: number, spreadAcross: number, spreadUp: number): number {
  const ball = (radius * radius) / 4;
  const varianceAcross = ball + spreadAcross * spreadAcross;
  const varianceUp = ball + spreadUp * spreadUp;
  const falloff = (across * across) / (2 * varianceAcross) + (up * up) / (2 * varianceUp);
  if (falloff > BLOB_MAX_FALLOFF) {
    return 0;
  }
  const peak = Math.min(1, (radius * radius) / (2 * Math.sqrt(varianceAcross * varianceUp)));
  return peak * Math.exp(-falloff);
}

/** The view's axis that lies in a reflection's plane of incidence: up the screen off the floor, across it off a wall. */
export type InPlaneAxis = 'up' | 'across';

/** How wide (tiles) a reflection cone is across the view and up it. */
export interface ConeSpread {
  across: number;
  up: number;
}

/**
 * The widths of a cone `cone` tiles wide across the view and up it, into `out`, seen at `slant` (the cosine between the
 * view and the surface's normal). Mirror geometry: a microfacet tilted by δ within the plane of incidence turns the
 * reflected ray by 2δ at any angle, but tilted across that plane by only 2δ × slant. So the cone keeps its width along
 * `inPlane` and narrows by the slant along the other axis.
 */
export function spreadCone(cone: number, slant: number, inPlane: InPlaneAxis, out: ConeSpread): void {
  const narrowed = cone * slant;
  out.across = inPlane === 'across' ? cone : narrowed;
  out.up = inPlane === 'across' ? narrowed : cone;
}
