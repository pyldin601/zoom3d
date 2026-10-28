import { describe, expect, it } from 'vitest';
import { LEVEL1 } from '../map/level1';
import { parseMap } from '../map/map';
import { findDoorways } from './doorways';

describe('findDoorways', () => {
  it('finds the 24 doorways of level 1, in both axes', () => {
    const doorways = findDoorways(parseMap(LEVEL1));
    expect(doorways).toHaveLength(24);
    expect(doorways).toContainEqual({ x: 34, y: 8, axis: 'ns' });
    expect(doorways).toContainEqual({ x: 28, y: 4, axis: 'we' });
  });

  it('finds none in a corridor three tiles wide', () => {
    const corridor = parseMap(['11111', '1...1', '1.S.1', '1...1', '11111'].join('\n'));
    expect(findDoorways(corridor)).toEqual([]);
  });

  it('finds a one-tile gap in a wall, walls west and east for a north-south passage', () => {
    const map = parseMap(['11111', '1...1', '11.11', '1.S.1', '11111'].join('\n'));
    expect(findDoorways(map)).toEqual([{ x: 2, y: 2, axis: 'ns' }]);
  });
});
