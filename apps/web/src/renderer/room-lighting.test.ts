import { describe, expect, test, vi } from 'vitest';
import { bakeLighting, bakePortalLighting } from './lighting';
import { createRoomLighting, roomLightingByRoom } from './room-lighting';
import { portalHall } from './test-portals';
import { CEILING, FLOOR } from './walls';

vi.mock('./lighting', async (importOriginal) => {
  const original = await importOriginal<typeof import('./lighting')>();
  return { ...original, bakePortalLighting: vi.fn(original.bakePortalLighting) };
});

const { map, portals } = portalHall();
const plain = bakeLighting(map, [{ x: 3.5, y: 5.5, z: 0.85, radius: 4.5, r: 1, g: 0.9, b: 0.8 }], 0.3, FLOOR, CEILING);

describe('createRoomLighting', () => {
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

describe('roomLightingByRoom', () => {
  const wireByRoom = () => {
    const wirings = new Map([
      ['room-a', portalHall().portals],
      ['room-b', portalHall().portals],
    ]);
    return (roomId: string) => wirings.get(roomId) ?? portals;
  };

  test('a room id is baked once, however often its lighting is asked for', () => {
    vi.mocked(bakePortalLighting).mockClear();
    const lightingFor = roomLightingByRoom(() => plain, wireByRoom());

    const first = lightingFor('room-a');

    expect(lightingFor('room-a')).toBe(first);
    expect(bakePortalLighting).toHaveBeenCalledTimes(1);
  });

  test('a new room id is baked again, with its own wiring', () => {
    const wire = wireByRoom();
    const lightingFor = roomLightingByRoom(() => plain, wire);

    const a = lightingFor('room-a');
    const b = lightingFor('room-b');

    expect(b).not.toBe(a);
    expect(b.portals).toBe(wire('room-b'));
    expect(b.lighting(true)?.portals).toBe(wire('room-b'));
  });

  test('nothing is baked for an unlit page', () => {
    vi.mocked(bakePortalLighting).mockClear();
    const lightingFor = roomLightingByRoom(() => null, wireByRoom());

    expect(lightingFor('room-a').lighting(true)).toBeNull();
    expect(bakePortalLighting).not.toHaveBeenCalled();
  });
});
