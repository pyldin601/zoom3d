import { LEVEL1, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { automapLayout } from './automap';

const map = parseMap(LEVEL1);

describe('automapLayout', () => {
  test('fits the level into 90% of a 1920x1080 HUD with whole-pixel cells, centred', () => {
    expect(automapLayout(map, 1920, 1080)).toEqual({ originX: 424, originY: 55, cell: 17 });
  });

  test('a tiny HUD still gives a 1 px cell and finite origin', () => {
    const layout = automapLayout(map, 1, 1);
    expect(layout.cell).toBe(1);
    expect(Number.isFinite(layout.originX)).toBe(true);
    expect(Number.isFinite(layout.originY)).toBe(true);
  });
});
