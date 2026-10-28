// Rigid 2D transforms whose rotation is a multiple of 90 degrees: p' = R·p + t. Pure; the out objects are reused.

export interface RigidTransform {
  cos: number;
  sin: number;
  tx: number;
  ty: number;
}

type Vec = { x: number; y: number };

export function applyPoint(t: RigidTransform, x: number, y: number, out: Vec): Vec {
  out.x = t.cos * x - t.sin * y + t.tx;
  out.y = t.sin * x + t.cos * y + t.ty;
  return out;
}

export function applyDir(t: RigidTransform, dx: number, dy: number, out: Vec): Vec {
  out.x = t.cos * dx - t.sin * dy;
  out.y = t.sin * dx + t.cos * dy;
  return out;
}

const FULL_TURN = 2 * Math.PI;

/** The angle turned by the rotation, in [0, 2π). */
export function applyAngle(t: RigidTransform, angle: number): number {
  const turned = (angle + Math.atan2(t.sin, t.cos)) % FULL_TURN;
  return turned < 0 ? turned + FULL_TURN : turned;
}

export function invert(t: RigidTransform): RigidTransform {
  return {
    cos: t.cos,
    sin: -t.sin,
    tx: -(t.cos * t.tx + t.sin * t.ty),
    ty: t.sin * t.tx - t.cos * t.ty,
  };
}
