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

    expect(room.lighting(false, false)).toBe(plain);
    expect(room.lighting(true, false)).not.toBe(plain);
    expect(room.lighting(true, false)?.portals).toBe(portals);
    expect(room.lighting(true, false)).toBe(room.lighting(true, false));
  });

  test('the dark table has no lamps, and its floor, ceiling and walls are all black', () => {
    const dark = createRoomLighting(plain, portals).lighting(false, true);

    expect(dark).not.toBeNull();
    expect(dark?.lights).toEqual([]);
    const black = (cell: number) => (cell & 0xffffff) === 0;
    expect(dark?.floor.every(black)).toBe(true);
    expect(dark?.ceiling.every(black)).toBe(true);
    expect(dark?.wall.every(black)).toBe(true);
  });

  test('in the dark, with portals on or off, the table is the same one, keeping the portal glows’ shadows', () => {
    const room = createRoomLighting(plain, portals);
    const dark = room.lighting(true, true);

    expect(dark).not.toBe(room.lighting(true, false));
    expect(room.lighting(false, true)).toBe(dark);
    expect(dark?.portals).toBe(portals);
    expect(dark?.portalGlowSeen).toBe(room.lighting(true, false)?.portalGlowSeen);
  });

  test('an unlit room has no lighting, with portals on or off, dark or not', () => {
    const room = createRoomLighting(null, portals);

    for (const portalsOn of [false, true]) {
      for (const dark of [false, true]) {
        expect(room.lighting(portalsOn, dark)).toBeNull();
      }
    }
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
    expect(b.lighting(true, false)?.portals).toBe(wire('room-b'));
  });

  test('nothing is baked for an unlit page', () => {
    vi.mocked(bakePortalLighting).mockClear();
    const lightingFor = roomLightingByRoom(() => null, wireByRoom());

    expect(lightingFor('room-a').lighting(true, false)).toBeNull();
    expect(bakePortalLighting).not.toHaveBeenCalled();
  });
});
