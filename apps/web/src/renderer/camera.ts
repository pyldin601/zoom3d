// Camera facts every projection onto the framebuffer shares (walls, discs, voxel objects), and the per-frame view
// they project with.
import type { PlayerState } from '@zoom3d/shared';
import type { Framebuffer } from './framebuffer';

/** The camera (and every disc centre) sits at half wall height above the floor. */
export const EYE_HEIGHT = 0.5;
/** Nearer than this (tiles, along the view direction) nothing is drawn. */
export const MIN_DEPTH = 0.1;

/**
 * The camera for the frame being drawn: where the eye is, which way it faces, the camera plane to its right and the
 * projection onto the frame. Each pass keeps one, set once per frame by setView, and hands it down.
 */
export interface View {
  /** The eye, in tiles. */
  x: number;
  y: number;
  /** Unit facing. */
  dirX: number;
  dirY: number;
  /** The camera plane, to the right of facing, tan(fov / 2) long: it spans the frame's width at depth 1. */
  planeX: number;
  planeY: number;
  /**
   * Turns an offset (dx, dy) from the eye into camera space: invDet · (dirY·dx − dirX·dy) across the plane (÷ depth:
   * −1 at the left edge, 1 at the right) and invDet · (−planeY·dx + planeX·dy) along the view, the depth.
   */
  invDet: number;
  /** Pixels per tile at depth 1: half the frame's width over tan(fov / 2). */
  proj: number;
  /** Half the frame's width and height (the eye line's row), px. */
  halfWidth: number;
  half: number;
}

export function createView(): View {
  return { x: 0, y: 0, dirX: 0, dirY: 0, planeX: 0, planeY: 0, invDet: 0, proj: 0, halfWidth: 0, half: 0 };
}

/** Points `view` from `p` across a frame of this size and FOV, and returns it. */
export function setView(view: View, fb: Pick<Framebuffer, 'width' | 'height' | 'fov'>, p: PlayerState): View {
  const planeLen = Math.tan(fb.fov / 2);
  view.x = p.x;
  view.y = p.y;
  view.dirX = Math.cos(p.angle);
  view.dirY = Math.sin(p.angle);
  // Camera plane points to the right of facing: (-sin, cos) in y-down coordinates.
  view.planeX = -view.dirY * planeLen;
  view.planeY = view.dirX * planeLen;
  view.invDet = 1 / (view.planeX * view.dirY - view.dirX * view.planeY);
  view.proj = fb.width / 2 / planeLen;
  view.halfWidth = fb.width / 2;
  view.half = fb.height / 2;
  return view;
}
