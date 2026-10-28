import { describe, expect, it } from 'vitest';
import { LEVEL1 } from '../map/level1';
import { parseMap } from '../map/map';
import { applyDir, applyPoint, type RigidTransform } from './transform';
import { wirePortals } from './wiring';

const map = parseMap(LEVEL1);
const point = { x: 0, y: 0 };

describe('wirePortals', () => {
  it('is deterministic per room id and differs between rooms', () => {
    const first = wirePortals(map, 'abc');
    const again = wirePortals(map, 'abc');
    expect(again.list.map((p) => p.to)).toEqual(first.list.map((p) => p.to));
    expect(again.list.map((p) => [p.nx, p.ny])).toEqual(first.list.map((p) => [p.nx, p.ny]));
    expect(wirePortals(map, 'abd').list.map((p) => p.to)).not.toEqual(first.list.map((p) => p.to));
  });

  it('sends every portal to another one, each destination used once', () => {
    const { list } = wirePortals(map, 'abc');
    expect(list.every((portal, i) => portal.to !== i)).toBe(true);
    expect(list.map((p) => p.to).sort((a, b) => a - b)).toEqual(list.map((_, i) => i));
  });

  it('has unit normals across the passage axis', () => {
    for (const { door, nx, ny } of wirePortals(map, 'abc').list) {
      expect(door.axis === 'ns' ? [nx === 0, Math.abs(ny)] : [ny === 0, Math.abs(nx)]).toEqual([true, 1]);
    }
  });

  it('maps centre to destination centre and normal to destination normal with exact quarter turns', () => {
    const { list } = wirePortals(map, 'abc');
    for (const portal of list) {
      const dest = list[portal.to] as (typeof list)[number];
      const { toDest } = portal;
      expect(Math.abs(toDest.cos) + Math.abs(toDest.sin)).toBe(1);
      expect(applyPoint(toDest, portal.cx, portal.cy, point)).toEqual({ x: dest.cx, y: dest.cy });
      expect(applyDir(toDest, portal.nx, portal.ny, point)).toEqual({ x: dest.nx, y: dest.ny });
    }
  });

  it('keeps fromDest the inverse of toDest', () => {
    for (const portal of wirePortals(map, 'abc').list) {
      const there = applyPoint(portal.toDest, 12.3, 4.5, { x: 0, y: 0 });
      const back = applyPoint(portal.fromDest as RigidTransform, there.x, there.y, { x: 0, y: 0 });
      expect(back.x).toBeCloseTo(12.3);
      expect(back.y).toBeCloseTo(4.5);
    }
  });

  it('indexes portals by tile', () => {
    const { list, byTile } = wirePortals(map, 'abc');
    list.forEach((portal, i) => {
      expect(byTile[portal.door.y * map.width + portal.door.x]).toBe(i);
    });
    expect(byTile.filter((i) => i >= 0)).toHaveLength(list.length);
  });
});
