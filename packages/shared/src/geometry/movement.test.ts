import { describe, expect, test } from 'vitest';
import { isWallAt, parseMap } from '../map/map';
import { MAX_DT, MOVE_SPEED, type MoveInput, PLAYER_RADIUS, type PlayerState, stepPlayer } from './movement';

const ROOM = parseMap('11111\n1...1\n1.S.1\n1...1\n11111');
const input = (forward = 0, strafe = 0, turn = 0): MoveInput => ({ forward, strafe, turn });
const player = (x: number, y: number, angle = 0): PlayerState => ({ x, y, angle });

function boxInWall(p: PlayerState): boolean {
  const r = PLAYER_RADIUS;
  return [
    [p.x - r, p.y - r],
    [p.x + r, p.y - r],
    [p.x - r, p.y + r],
    [p.x + r, p.y + r],
  ].some(([x, y]) => isWallAt(ROOM, x as number, y as number));
}

describe('stepPlayer', () => {
  test('moves forward at MOVE_SPEED', () => {
    const p = stepPlayer(ROOM, player(2.5, 2.5), input(1), 0.1, player(0, 0));
    expect(p.x).toBeCloseTo(2.8);
    expect(p.y).toBeCloseTo(2.5);
  });

  test('stops at the wall', () => {
    let p = player(2.5, 2.5);
    for (let i = 0; i < 50; i++) p = stepPlayer(ROOM, p, input(1), 0.1, player(0, 0));
    expect(p.x).toBeLessThanOrEqual(4 - PLAYER_RADIUS);
    expect(boxInWall(p)).toBe(false);
  });

  test('clamps huge dt so the player cannot tunnel', () => {
    const p = stepPlayer(ROOM, player(2.5, 2.5), input(1), 5, player(0, 0));
    expect(p.x - 2.5).toBeLessThanOrEqual(MOVE_SPEED * MAX_DT + 1e-9);
  });

  test('ignores negative dt', () => {
    const p = stepPlayer(ROOM, player(2.5, 2.5), input(1), -1, player(0, 0));
    expect(p.x).toBe(2.5);
  });

  test('diagonal push into a corner neither passes through nor gets stuck in the wall', () => {
    let p = player(3.5, 3.5, Math.PI / 4);
    for (let i = 0; i < 20; i++) {
      p = stepPlayer(ROOM, p, input(1), 0.1, player(0, 0));
      expect(boxInWall(p)).toBe(false);
    }
    expect(p.x).toBeGreaterThan(3.5);
    expect(p.x).toBeLessThanOrEqual(3.75);
    expect(p.y).toBeGreaterThan(3.5);
    expect(p.y).toBeLessThanOrEqual(3.75);
  });

  test('slides along a wall', () => {
    const p = stepPlayer(ROOM, player(3.7, 2.0, Math.PI / 4), input(1), 0.1, player(0, 0));
    expect(p.x).toBeLessThanOrEqual(3.75);
    expect(p.y).toBeGreaterThan(2.1);
  });

  test('strafe right at angle 0 moves +y', () => {
    const p = stepPlayer(ROOM, player(2.5, 2.5), input(0, 1), 0.1, player(0, 0));
    expect(p.y).toBeCloseTo(2.8);
  });

  test('forward + strafe is normalised to MOVE_SPEED', () => {
    const p = stepPlayer(ROOM, player(2.5, 2.5), input(1, 1), 0.1, player(0, 0));
    expect(Math.hypot(p.x - 2.5, p.y - 2.5)).toBeCloseTo(MOVE_SPEED * 0.1);
  });

  test('turning right increases the angle and wraps into [0, 2π)', () => {
    expect(stepPlayer(ROOM, player(2.5, 2.5, 0), input(0, 0, 1), 0.1, player(0, 0)).angle).toBeCloseTo(0.25);
    const wrapped = stepPlayer(ROOM, player(2.5, 2.5, 2 * Math.PI - 0.1), input(0, 0, 1), 0.1, player(0, 0));
    expect(wrapped.angle).toBeCloseTo(0.15);
    const back = stepPlayer(ROOM, player(2.5, 2.5, 0.1), input(0, 0, -1), 0.1, player(0, 0));
    expect(back.angle).toBeCloseTo(2 * Math.PI - 0.15);
  });

  test('can write into the same object it reads', () => {
    const p = player(2.5, 2.5);
    expect(stepPlayer(ROOM, p, input(1), 0.1, p)).toBe(p);
    expect(p.x).toBeCloseTo(2.8);
  });
});
