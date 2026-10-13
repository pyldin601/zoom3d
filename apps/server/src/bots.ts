// Wandering bots (`?bots=N`): server-driven peers for testing large rooms. They have no connection or media, walk
// straight on below walking pace, and turn when they hit a wall or now and then on their own. Pure: the lobby owns
// them as peers and calls stepBot on every world step.
import { type GameMap, isWallAt, pick, stepPlayer } from '@zoom3d/shared';

/** Rooms that may have bots at once on one server, so a public link can't load casa with thousands. */
export const MAX_BOT_ROOMS = 3;
/** Muted colours, never a player colour, so people stand out from bots. */
export const BOT_COLORS = ['#7f8c8d', '#95a5a6', '#8d7b68', '#6c7a89', '#a09080'] as const;
/** Bots walk at this fraction of walking pace (MOVE_SPEED). */
const BOT_PACE = 0.6;
/** On average, a bot that isn't blocked turns on its own about this often (seconds). */
const BOT_TURN_EVERY_S = 8;
/** A bot covering under this many tiles per second of walk time has hit a wall (a sixth of MOVE_SPEED). */
const BLOCKED_SPEED = 0.5;
const FORWARD = { forward: 1, strafe: 0, turn: 0 };
const TWO_PI = Math.PI * 2;

interface Pose {
  x: number;
  y: number;
  angle: number;
}

/** Where stepBot's collision step writes, so stepping allocates nothing. */
const scratch: Pose = { x: 0, y: 0, angle: 0 };

/** Every floor tile (tile coordinates); the map validator guarantees each one is reachable from the spawn. */
export function floorTiles(map: GameMap): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!isWallAt(map, x + 0.5, y + 0.5)) {
        tiles.push({ x, y });
      }
    }
  }
  return tiles;
}

/** The `i`th bot's name, colour and starting pose: a random floor tile's centre, facing a random way. */
export function placeBot(
  i: number,
  floor: readonly { x: number; y: number }[],
  rng: () => number
): Pose & { name: string; color: string } {
  const tile = pick(rng, floor);
  if (!tile) {
    throw new Error('the map has no floor for bots');
  }
  return {
    name: `Bot ${String(i + 1).padStart(3, '0')}`,
    color: BOT_COLORS.at(i % BOT_COLORS.length) ?? BOT_COLORS[0],
    x: tile.x + 0.5,
    y: tile.y + 0.5,
    angle: rng() * TWO_PI,
  };
}

/** Walks the bot dt seconds straight on; a wall turns it to a random heading, and now and then it turns on its own. */
export function stepBot(map: GameMap, bot: Pose, dt: number, rng: () => number): void {
  // stepPlayer walks at MOVE_SPEED for the time it is given: less time is a slower walk.
  const walkTime = dt * BOT_PACE;
  const to = stepPlayer(map, bot, FORWARD, walkTime, scratch);
  const travelled = Math.hypot(to.x - bot.x, to.y - bot.y);
  if (travelled < walkTime * BLOCKED_SPEED) {
    bot.angle = rng() * TWO_PI;
    return;
  }
  bot.x = to.x;
  bot.y = to.y;
  if (rng() < dt / BOT_TURN_EVERY_S) {
    bot.angle += (rng() - 0.5) * Math.PI;
  }
}
