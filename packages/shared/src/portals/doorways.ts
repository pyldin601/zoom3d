// Doorways: floor tiles in a wall with floor on one pair of opposite sides and walls on the other. Pure.

import { type GameMap, tileAt } from '../map/map';

export interface Doorway {
  x: number;
  y: number;
  /** 'ns': the passage runs north-south (walls west and east); 'we': west-east (walls north and south). */
  axis: 'ns' | 'we';
}

function isFloor(map: GameMap, x: number, y: number): boolean {
  return tileAt(map, x, y) === 0;
}

function axisOfDoorway(map: GameMap, x: number, y: number): Doorway['axis'] | null {
  if (!isFloor(map, x, y)) {
    return null;
  }
  const northSouthOpen = isFloor(map, x, y - 1) && isFloor(map, x, y + 1);
  const westEastOpen = isFloor(map, x - 1, y) && isFloor(map, x + 1, y);
  const northSouthWalled = !isFloor(map, x, y - 1) && !isFloor(map, x, y + 1);
  const westEastWalled = !isFloor(map, x - 1, y) && !isFloor(map, x + 1, y);
  if (northSouthOpen && westEastWalled) {
    return 'ns';
  }
  if (westEastOpen && northSouthWalled) {
    return 'we';
  }
  return null;
}

/** Every doorway of the map, in row-major order. */
export function findDoorways(map: GameMap): Doorway[] {
  const doorways: Doorway[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const axis = axisOfDoorway(map, x, y);
      if (axis !== null) {
        doorways.push({ x, y, axis });
      }
    }
  }
  return doorways;
}
