import { describe, expect, test } from 'vitest';
import { bakeLighting } from './lighting';
import { createRoomLighting } from './room-lighting';
import { portalHall } from './test-portals';
import { CEILING, FLOOR } from './walls';

describe('createRoomLighting', () => {
  const { map, portals } = portalHall();
  const plain = bakeLighting(
    map,
    [{ x: 3.5, y: 5.5, z: 0.85, radius: 4.5, r: 1, g: 0.9, b: 0.8 }],
    0.3,
    FLOOR,
    CEILING
  );

  test('lighting(true) is the portals-on table, lighting(false) the plain one', () => {
    const room = createRoomLighting(plain, portals);

    expect(room.lighting(false)).toBe(plain);
    expect(room.lighting(true)).not.toBe(plain);
    expect(room.lighting(true)?.portals).toBe(portals);
    expect(room.lighting(true)).toBe(room.lighting(true));
  });

  test('an unlit room has no lighting with portals on or off', () => {
    const room = createRoomLighting(null, portals);

    expect(room.lighting(true)).toBeNull();
    expect(room.lighting(false)).toBeNull();
  });
});
