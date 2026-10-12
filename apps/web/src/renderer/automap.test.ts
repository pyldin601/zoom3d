import { LEVEL1, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { automapLayout, drawAutomap } from './automap';
import { inLabelRange, LABEL_TILES } from './labels';

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

describe('drawAutomap', () => {
  /** A 2D context that records the text drawn and the dots filled. */
  function recorder() {
    const texts: string[] = [];
    let arcs = 0;
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'fillText') {
            return (text: string) => texts.push(text);
          }
          if (prop === 'arc') {
            return () => {
              arcs++;
            };
          }
          return () => {};
        },
        set: () => true,
      }
    ) as CanvasRenderingContext2D;
    return { ctx, texts, arcs: () => arcs };
  }

  test('everyone gets a dot, but only people within LABEL_TILES get their name', () => {
    const { ctx, texts, arcs } = recorder();
    const p = { x: 10, y: 10, angle: 0 };
    drawAutomap(ctx, map, p, 1920, 1080, [
      { x: 12, y: 10, color: '#fff', name: 'Near' },
      { x: 10, y: 10 + LABEL_TILES, color: '#fff', name: 'Edge' },
      { x: 10 + LABEL_TILES + 1, y: 10, color: '#fff', name: 'Far' },
    ]);
    expect(arcs()).toBe(3);
    expect(texts).toEqual(['Near', 'Edge']);
  });
});

describe('inLabelRange', () => {
  test('within LABEL_TILES (10) tiles, straight line', () => {
    expect(LABEL_TILES).toBe(10);
    expect(inLabelRange({ x: 0, y: 0 }, 6, 8)).toBe(true);
    expect(inLabelRange({ x: 0, y: 0 }, 6, 8.01)).toBe(false);
  });
});
