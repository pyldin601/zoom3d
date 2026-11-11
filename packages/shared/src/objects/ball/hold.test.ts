import { describe, expect, test } from 'vitest';
import { isWallAt, parseMap } from '../../map/map';
import { crossedPortal } from '../../portals/crossing';
import { twoDoorways } from '../../portals/test-doorways';
import { BALL_RADIUS } from './ball';
import { HOLD_FORWARD_TILES, HOLD_SIDE_TILES, holdSpot } from './hold';

/** A room with open floor in the middle and a corner at the top left. */
const ROOM = parseMap(['11111111', '1......1', '1......1', '1...S..1', '1......1', '11111111'].join('\n'));

const clearOfWalls = (p: { x: number; y: number }) =>
  !isWallAt(ROOM, p.x + BALL_RADIUS, p.y) &&
  !isWallAt(ROOM, p.x - BALL_RADIUS, p.y) &&
  !isWallAt(ROOM, p.x, p.y + BALL_RADIUS) &&
  !isWallAt(ROOM, p.x, p.y - BALL_RADIUS);

describe('holdSpot', () => {
  test('in open floor it sits half a tile ahead and a fifth to the right', () => {
    const out = holdSpot(ROOM, null, 3.5, 3.5, 0, { x: 0, y: 0 });
    expect(out.x).toBeCloseTo(3.5 + HOLD_FORWARD_TILES);
    expect(out.y).toBeCloseTo(3.5 + HOLD_SIDE_TILES);
  });

  test('turning swings it round the player', () => {
    const out = holdSpot(ROOM, null, 3.5, 3.5, Math.PI / 2, { x: 0, y: 0 });
    expect(out.x).toBeCloseTo(3.5 - HOLD_SIDE_TILES);
    expect(out.y).toBeCloseTo(3.5 + HOLD_FORWARD_TILES);
  });

  test('facing a wall it is pulled back so the ball clears it', () => {
    // The east wall's face is at x = 7.
    const out = holdSpot(ROOM, null, 6.6, 3.5, 0, { x: 0, y: 0 });
    expect(7 - out.x).toBeGreaterThanOrEqual(BALL_RADIUS - 1e-9);
    expect(out.x).toBeGreaterThan(6.6);
    // On the segment from the player towards the free spot.
    expect((out.y - 3.5) / (out.x - 6.6)).toBeCloseTo(HOLD_SIDE_TILES / HOLD_FORWARD_TILES);
  });

  test('in a corner it never ends inside a wall', () => {
    const out = { x: 0, y: 0 };
    for (let i = 0; i < 32; i++) {
      holdSpot(ROOM, null, 1.3, 1.3, (i / 32) * 2 * Math.PI, out);
      expect(clearOfWalls(out)).toBe(true);
    }
  });

  test('a spot across a portal plane is pulled back to this side', () => {
    const { map, portals } = twoDoorways();
    const out = holdSpot(map, portals, 2.5, 3.2, Math.PI / 2, { x: 0, y: 0 });
    expect(crossedPortal(portals, 2.5, 3.2, out.x, out.y, { t: 0 })).toBe(-1);
    expect(out.y).toBeGreaterThan(3.2);
  });

  test('without portals the same spot goes through the doorway', () => {
    const { map } = twoDoorways();
    const out = holdSpot(map, null, 2.5, 3.2, Math.PI / 2, { x: 0, y: 0 });
    expect(out.y).toBeCloseTo(3.2 + HOLD_FORWARD_TILES);
  });

  test('it writes into the object it is given', () => {
    const out = { x: 0, y: 0 };
    expect(holdSpot(ROOM, null, 3.5, 3.5, 0, out)).toBe(out);
  });
});
