// Crossing a portal plane: the plane is the line through the doorway tile's centre, across the passage. Pure.

import { applyAngle, applyDir, applyPoint } from './transform';
import type { Portal, Portals } from './wiring';

/** Where along a→b the plane is crossed front to back, or −1 when the segment does not cross it. */
function fractionAcrossPlane(portal: Portal, ax: number, ay: number, bx: number, by: number): number {
  const sideOfStart = (ax - portal.cx) * portal.nx + (ay - portal.cy) * portal.ny;
  const sideOfEnd = (bx - portal.cx) * portal.nx + (by - portal.cy) * portal.ny;
  if (sideOfStart >= 0 || sideOfEnd < 0) {
    return -1;
  }
  const t = sideOfStart / (sideOfStart - sideOfEnd);
  const alongPlane = portal.door.axis === 'ns' ? ax + t * (bx - ax) : ay + t * (by - ay);
  const planeStart = portal.door.axis === 'ns' ? portal.door.x : portal.door.y;
  return alongPlane >= planeStart && alongPlane <= planeStart + 1 ? t : -1;
}

/** The first portal whose plane a→b crosses front→back inside its opening, or −1; `out.t` its fraction along a→b. */
export function crossedPortal(p: Portals, ax: number, ay: number, bx: number, by: number, out: { t: number }): number {
  const { width, height } = p.map;
  let x = Math.floor(ax);
  let y = Math.floor(ay);
  const endX = Math.floor(bx);
  const endY = Math.floor(by);
  const dx = bx - ax;
  const dy = by - ay;
  const stepX = dx < 0 ? -1 : 1;
  const stepY = dy < 0 ? -1 : 1;
  const deltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
  const deltaY = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
  let sideX = dx < 0 ? (ax - x) * deltaX : (x + 1 - ax) * deltaX;
  let sideY = dy < 0 ? (ay - y) * deltaY : (y + 1 - ay) * deltaY;
  const steps = Math.abs(endX - x) + Math.abs(endY - y);

  for (let i = 0; i <= steps; i++) {
    if (x >= 0 && y >= 0 && x < width && y < height) {
      const index = p.byTile[y * width + x] ?? -1;
      const portal = index < 0 ? undefined : p.list.at(index);
      if (portal !== undefined) {
        const t = fractionAcrossPlane(portal, ax, ay, bx, by);
        if (t >= 0) {
          out.t = t;
          return index;
        }
      }
    }
    if (sideX < sideY) {
      sideX += deltaX;
      x += stepX;
    } else {
      sideY += deltaY;
      y += stepY;
    }
  }
  return -1;
}

const crossing = { t: 0 };
const carried = { x: 0, y: 0 };
const carriedVelocity = { x: 0, y: 0 };

/** Carries a pose that just moved from (ax, ay) through the portal it crossed, if any; also rotates `vel`. */
export function carryThroughPortal(
  p: Portals | null,
  ax: number,
  ay: number,
  pose: { x: number; y: number; angle: number },
  vel?: { vx: number; vy: number }
): boolean {
  if (p === null) {
    return false;
  }
  const index = crossedPortal(p, ax, ay, pose.x, pose.y, crossing);
  const portal = index < 0 ? undefined : p.list.at(index);
  if (portal === undefined) {
    return false;
  }
  // The rigid transform is affine: carrying the end point carries the crossing point plus the rest of the move.
  applyPoint(portal.toDest, pose.x, pose.y, carried);
  pose.x = carried.x;
  pose.y = carried.y;
  pose.angle = applyAngle(portal.toDest, pose.angle);
  if (vel !== undefined) {
    applyDir(portal.toDest, vel.vx, vel.vy, carriedVelocity);
    vel.vx = carriedVelocity.x;
    vel.vy = carriedVelocity.y;
  }
  return true;
}
