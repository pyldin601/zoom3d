import { describe, expect, it } from 'vitest';
import { applyAngle, applyDir, applyPoint, invert, type RigidTransform } from './transform';

const quarterTurn: RigidTransform = { cos: 0, sin: 1, tx: 5, ty: -2 };
const out = { x: 0, y: 0 };

describe('RigidTransform', () => {
  it('rotates then translates a point', () => {
    expect(applyPoint(quarterTurn, 1, 0, out)).toEqual({ x: 5, y: -1 });
  });

  it('rotates a direction without translating it', () => {
    expect(applyDir(quarterTurn, 1, 0, out)).toEqual({ x: 0, y: 1 });
  });

  it('returns the out object it was given', () => {
    expect(applyPoint(quarterTurn, 1, 0, out)).toBe(out);
    expect(applyDir(quarterTurn, 1, 0, out)).toBe(out);
  });

  it('turns an angle by the rotation, normalised to [0, 2π)', () => {
    expect(applyAngle(quarterTurn, 0)).toBeCloseTo(Math.PI / 2);
    expect(applyAngle(quarterTurn, (3 * Math.PI) / 2 + 0.1)).toBeCloseTo(0.1);
    const half: RigidTransform = { cos: -1, sin: 0, tx: 0, ty: 0 };
    const turned = applyAngle(half, 0.5);
    expect(turned).toBeGreaterThanOrEqual(0);
    expect(turned).toBeLessThan(2 * Math.PI);
  });

  it('inverts: undoing the transform gives the point back', () => {
    const back = applyPoint(invert(quarterTurn), ...pair(applyPoint(quarterTurn, 3.5, 7.25, { x: 0, y: 0 })), {
      x: 0,
      y: 0,
    });
    expect(back.x).toBeCloseTo(3.5);
    expect(back.y).toBeCloseTo(7.25);
  });
});

function pair(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}
