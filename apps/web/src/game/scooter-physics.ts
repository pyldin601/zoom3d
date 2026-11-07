// Riding an electric scooter (electric scooter spec §4.1): the throttle, coasting, the brake and backing up, steering,
// and walls. Run only on the rider's own screen; everyone else sees the motion as they see any walker. Pure and
// allocation-free.
import {
  carryThroughPortal,
  type GameMap,
  MAX_STEP_S,
  type MoveInput,
  moveWithCollision,
  type PlayerState,
  type Portals,
  RIDE_SPEED,
  TURN_SPEED,
} from '@zoom3d/shared';

export interface RideState {
  /** Tiles/s along the heading; negative while backing up. */
  speed: number;
  /** The speed this step hit a wall head-on at, for the bump's sound; 0 on every other step. */
  bump: number;
}

/** Starting values for the owner to tune by riding. Tiles/s² unless named otherwise. */
const THROTTLE = 4;
const COAST = 1.5;
const BRAKE = 10;
const REVERSE_SPEED = -1;
const REVERSE = 3;
/** At full speed the keys turn this much slower: the scooter can't take a corner sharply at speed. */
const FULL_SPEED_TURN_LOSS = 0.4;
/** A step whose free share is under sin 20° hit the wall all but head-on. */
const HEAD_ON_SHARE = Math.sin((20 * Math.PI) / 180);
/** Riding along an axis leaves a rounding-error step on the other one, which never moves the pose: not a wall. */
const NO_STEP = 1e-9;

export const createRideState = (): RideState => ({ speed: 0, bump: 0 });

/** Moves `value` toward `target` by at most `by`. */
const toward = (value: number, target: number, by: number) =>
  value < target ? Math.min(target, value + by) : Math.max(target, value - by);

const clamp = (v: number) => Math.min(1, Math.max(-1, v));

/** The speed after `dt` of this input, with nothing in the way. */
function nextSpeed(speed: number, forward: number, dt: number): number {
  if (forward > 0) {
    return Math.min(RIDE_SPEED, speed + THROTTLE * forward * dt);
  }
  if (forward < 0) {
    return speed > 0 ? Math.max(0, speed - BRAKE * dt) : toward(speed, REVERSE_SPEED, REVERSE * dt);
  }
  return toward(speed, 0, COAST * dt);
}

/**
 * One step of the ride: keys (and A/D, which steer on a scooter) turn it, slower at speed; it moves along its heading,
 * then the input sets the speed, unless a wall decided it: a head-on one stops it dead, scraping one slows it at the
 * brake rate. The mouse turns `pose.angle` before this, freely, as on foot.
 */
export function stepRide(
  map: GameMap,
  pose: PlayerState,
  ride: RideState,
  input: MoveInput,
  dt: number,
  portals: Portals | null
): void {
  const t = Math.min(Math.max(dt, 0), MAX_STEP_S);
  const turnRate = TURN_SPEED * (1 - (FULL_SPEED_TURN_LOSS * Math.abs(ride.speed)) / RIDE_SPEED);
  pose.angle += clamp(input.turn + input.strafe) * turnRate * t;

  const dx = Math.cos(pose.angle) * ride.speed * t;
  const dy = Math.sin(pose.angle) * ride.speed * t;
  const startX = pose.x;
  const startY = pose.y;
  const moved = moveWithCollision(map, startX, startY, dx, dy);
  const blockedX = Math.abs(dx) > NO_STEP && moved.x === startX;
  const blockedY = Math.abs(dy) > NO_STEP && moved.y === startY;
  pose.x = moved.x;
  pose.y = moved.y;
  carryThroughPortal(portals, startX, startY, pose);

  ride.bump = 0;
  if (blockedX || blockedY) {
    const step = Math.hypot(dx, dy);
    const free = blockedX ? (blockedY ? 0 : Math.abs(dy)) : Math.abs(dx);
    if (free / step < HEAD_ON_SHARE) {
      ride.bump = Math.abs(ride.speed);
      ride.speed = 0;
    } else {
      ride.speed = toward(ride.speed, 0, BRAKE * t);
    }
  } else {
    ride.speed = nextSpeed(ride.speed, input.forward, t);
  }
}
