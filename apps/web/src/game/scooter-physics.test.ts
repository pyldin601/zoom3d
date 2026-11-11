import { MAX_STEP_S, type MoveInput, type PlayerState, parseMap, RIDE_SPEED, TURN_SPEED } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { twoDoorways } from '../../../../packages/shared/src/portals/test-doorways';
import { createRideState, type RideState, stepRide } from './scooter-physics';

/** A long east-west hall, rows y = 1..3, walls at x = 0 and x = 59. */
const HALL = parseMap(
  ['1'.repeat(60), `1S${'.'.repeat(57)}1`, `1${'.'.repeat(58)}1`, `1${'.'.repeat(58)}1`, '1'.repeat(60)].join('\n')
);
const DT = 1 / 60;
const input = (forward = 0, strafe = 0, turn = 0): MoveInput => ({ forward, strafe, turn });
const THROTTLE = input(1);
const COAST = input();
const BRAKE = input(-1);

function ride(pose: PlayerState, state: RideState, move: MoveInput, seconds: number, dt = DT): void {
  for (let i = Math.round(seconds / dt); i > 0; i--) {
    stepRide(HALL, pose, state, move, dt, null);
  }
}
const at = (x: number, y = 2.5, angle = 0): PlayerState => ({ x, y, angle });
const moving = (speed: number): RideState => ({ ...createRideState(), speed });

describe('speed', () => {
  test('throttle reaches RIDE_SPEED in about 1.5 s and never passes it', () => {
    const pose = at(2);
    const state = createRideState();
    ride(pose, state, THROTTLE, 1.4);
    expect(state.speed).toBeLessThan(RIDE_SPEED);
    ride(pose, state, THROTTLE, 0.2);
    expect(state.speed).toBe(RIDE_SPEED);
    ride(pose, state, THROTTLE, 1.4);
    expect(state.speed).toBe(RIDE_SPEED);
  });

  test('coasting from full speed stops in about 4 s', () => {
    const pose = at(2);
    const state = moving(RIDE_SPEED);
    ride(pose, state, COAST, 3.9);
    expect(state.speed).toBeGreaterThan(0);
    ride(pose, state, COAST, 0.2);
    expect(state.speed).toBe(0);
  });

  test('S brakes, then backs up no faster than 1 tile/s', () => {
    const pose = at(30);
    const state = moving(RIDE_SPEED);
    ride(pose, state, BRAKE, 0.62);
    expect(state.speed).toBeLessThanOrEqual(0);
    let slowest = 0;
    for (let t = 0; t < 1; t += DT) {
      stepRide(HALL, pose, state, BRAKE, DT, null);
      slowest = Math.min(slowest, state.speed);
    }
    expect(state.speed).toBeCloseTo(-1);
    expect(slowest).toBeGreaterThanOrEqual(-1);
  });

  test('a huge step is clamped like walking', () => {
    const pose = at(10);
    stepRide(HALL, pose, moving(RIDE_SPEED), COAST, 5, null);
    expect(pose.x - 10).toBeLessThanOrEqual(RIDE_SPEED * MAX_STEP_S + 1e-9);
  });
});

describe('steering', () => {
  test('A and D steer, and the scooter moves only along its heading', () => {
    const pose = at(10);
    const state = moving(3);
    const before = { ...pose };
    stepRide(HALL, pose, state, input(0, 1), DT, null);
    expect(pose.angle).toBeGreaterThan(0);
    const heading = Math.atan2(pose.y - before.y, pose.x - before.x);
    expect(heading).toBeCloseTo(pose.angle, 5);
  });

  test('keys turn half as fast as on foot once rolling, and 60% of that at full speed', () => {
    const rolling = at(10);
    stepRide(HALL, rolling, moving(0.5), input(0, 0, 1), DT, null);
    expect(rolling.angle).toBeCloseTo(0.5 * TURN_SPEED * DT * (1 - (0.4 * 0.5) / RIDE_SPEED), 6);
    const fast = at(10);
    stepRide(HALL, fast, moving(RIDE_SPEED), input(0, 0, 1), DT, null);
    expect(fast.angle).toBeCloseTo(0.5 * 0.6 * TURN_SPEED * DT, 6);
  });

  test('backing up, the same key swings the nose the other way, as the front wheel steers', () => {
    const forward = at(10);
    stepRide(HALL, forward, moving(2), input(0, 1), DT, null);
    const backward = at(10);
    stepRide(HALL, backward, moving(-1), input(0, 1), DT, null);
    expect(forward.angle).toBeGreaterThan(0);
    expect(backward.angle).toBeLessThan(0);
  });

  test('at a standstill the keys do nothing, and turning fades in as it rolls', () => {
    const still = at(10);
    stepRide(HALL, still, moving(0), input(0, 1), DT, null);
    const creeping = at(10);
    stepRide(HALL, creeping, moving(0.25), input(0, 1), DT, null);
    const rolling = at(10);
    stepRide(HALL, rolling, moving(0.5), input(0, 1), DT, null);
    expect(still.angle).toBe(0);
    expect(creeping.angle / rolling.angle).toBeCloseTo(0.5, 1);
  });
});

describe('walls', () => {
  test('a wall head-on stops it dead, and throttling into it gets nowhere', () => {
    const pose = at(57.5);
    const state = moving(RIDE_SPEED);
    ride(pose, state, COAST, 0.5);
    expect(state.speed).toBe(0);
    ride(pose, state, THROTTLE, 0.5);
    expect(state.speed).toBeLessThanOrEqual(4 * DT + 1e-9);
    expect(pose.x).toBeLessThan(59);
  });

  test('a wall within 20° of head-on stops it dead too', () => {
    const pose = at(57.5, 2.5, (15 * Math.PI) / 180);
    const state = moving(RIDE_SPEED);
    ride(pose, state, COAST, 0.5);
    expect(state.speed).toBe(0);
  });

  test('scraping a wall at 45° slows at the brake rate, whatever the frame rate', () => {
    for (const dt of [1 / 30, 1 / 144]) {
      const pose = at(10, 3.74, Math.PI / 4);
      const state = moving(RIDE_SPEED);
      ride(pose, state, COAST, 0.3, dt);
      expect(state.speed).toBeCloseTo(3, 1);
    }
  });

  test('throttling through a doorway while rubbing its side at 15° gets out the far side', () => {
    const doorway = parseMap(
      ['1111111111', '1S...1...1', '1....1...1', '1........1', '1....1...1', '1111111111'].join('\n')
    );
    const pose = at(3, 3.15, (15 * Math.PI) / 180);
    const state = createRideState();
    for (let i = 0; i < 120; i++) {
      stepRide(doorway, pose, state, THROTTLE, DT, null);
    }
    expect(pose.x).toBeGreaterThan(7);
  });

  test('a steep scrape stops it even with the throttle held', () => {
    const pose = at(10, 3.74, Math.PI / 3);
    const state = moving(3);
    ride(pose, state, THROTTLE, 0.5);
    expect(state.speed).toBeLessThan(0.1);
  });
});

test('speed carries through a portal', () => {
  const { map, portals } = twoDoorways();
  const pose = { x: 2.5, y: 3.4, angle: Math.PI / 2 };
  const state = moving(4);
  for (let i = 0; i < 10; i++) {
    stepRide(map, pose, state, COAST, 0.05, portals);
  }
  expect(pose.x).toBeCloseTo(4.5);
  expect(state.speed).toBeGreaterThan(3);
});

describe('bumps', () => {
  test('a head-on stop reports the speed it hit at, once', () => {
    const pose = at(58.4);
    const state = moving(RIDE_SPEED);
    let hit = 0;
    let steps = 0;
    while (state.speed > 0 && steps < 60) {
      stepRide(HALL, pose, state, COAST, DT, null);
      steps++;
      hit = state.bump;
    }
    expect(hit).toBeGreaterThan(5.5);
    stepRide(HALL, pose, state, COAST, DT, null);
    expect(state.bump).toBe(0);
  });

  test('scraping reports no bump', () => {
    const pose = at(10, 3.74, Math.PI / 4);
    const state = moving(RIDE_SPEED);
    for (let i = 0; i < 18; i++) {
      stepRide(HALL, pose, state, COAST, DT, null);
      expect(state.bump).toBe(0);
    }
  });
});
