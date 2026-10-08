// Grid map: parsing, tile queries, invariants and spawn placement.

export interface GameMap {
  width: number;
  height: number;
  /** Row-major tile ids: 0 floor, 1 stone, 2 wood, 3 blue stone. */
  tiles: Uint8Array;
  /** Tile index of the `S` marker. */
  spawn: { x: number; y: number };
}

const TILE_CHARS: Record<string, number> = { '.': 0, S: 0, '1': 1, '2': 2, '3': 3 };
const OUT_OF_BOUNDS = 1;

export function parseMap(text: string): GameMap {
  const rows = text.replace(/^\s*\n|\n\s*$/g, '').split('\n');
  const width = rows[0]?.length ?? 0;
  const height = rows.length;
  const tiles = new Uint8Array(width * height);
  const spawns: { x: number; y: number }[] = [];
  rows.forEach((row, y) => {
    if (row.length !== width)
      throw new Error(`map row ${y + 1}: expected ${width} columns, got ${row.length}`);
    for (let x = 0; x < width; x++) {
      const ch = row[x] as string;
      const tile = TILE_CHARS[ch];
      if (tile === undefined)
        throw new Error(`map row ${y + 1}: unknown character '${ch}' at column ${x + 1}`);
      if (ch === 'S') spawns.push({ x, y });
      tiles[y * width + x] = tile;
    }
  });
  if (spawns.length !== 1) throw new Error(`map must have exactly one spawn 'S', found ${spawns.length}`);
  return { width, height, tiles, spawn: spawns[0] as { x: number; y: number } };
}

export function tileAt(map: GameMap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return OUT_OF_BOUNDS;
  return map.tiles[y * map.width + x] as number;
}

export function isWallAt(map: GameMap, x: number, y: number): boolean {
  return tileAt(map, Math.floor(x), Math.floor(y)) !== 0;
}

function reachableFromSpawn(map: GameMap): Set<number> {
  const seen = new Set<number>();
  const stack = [map.spawn.y * map.width + map.spawn.x];
  while (stack.length > 0) {
    const i = stack.pop() as number;
    if (seen.has(i)) continue;
    seen.add(i);
    const x = i % map.width;
    const y = (i - x) / map.width;
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      if (tileAt(map, nx, ny) === 0) stack.push(ny * map.width + nx);
    }
  }
  return seen;
}

/** Returns human-readable invariant violations; empty when the map is valid. */
export function validateMap(map: GameMap): string[] {
  const errors: string[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const onBorder = x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1;
      if (onBorder && tileAt(map, x, y) === 0) errors.push(`border tile (${x}, ${y}) is not a wall`);
    }
  }
  if (errors.length > 0) return errors;
  const reachable = reachableFromSpawn(map);
  for (let i = 0; i < map.tiles.length; i++) {
    if (map.tiles[i] === 0 && !reachable.has(i)) {
      errors.push(`floor tile (${i % map.width}, ${Math.floor(i / map.width)}) is unreachable from spawn`);
    }
  }
  return errors;
}

const SPAWN_RADIUS = 2;
const CARDINALS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2] as const;

/** A random floor tile centre within SPAWN_RADIUS of `S`, facing a random open cardinal direction. */
export function spawnPoint(map: GameMap, rng: () => number): { x: number; y: number; angle: number } {
  const candidates: { x: number; y: number }[] = [];
  const { x: sx, y: sy } = map.spawn;
  for (let y = sy - SPAWN_RADIUS; y <= sy + SPAWN_RADIUS; y++) {
    for (let x = sx - SPAWN_RADIUS; x <= sx + SPAWN_RADIUS; x++) {
      if (tileAt(map, x, y) === 0 && Math.hypot(x - sx, y - sy) <= SPAWN_RADIUS) candidates.push({ x, y });
    }
  }
  const tile = candidates[Math.floor(rng() * candidates.length)] ?? map.spawn;
  const open = CARDINALS.filter(
    (a) => tileAt(map, tile.x + Math.round(Math.cos(a)), tile.y + Math.round(Math.sin(a))) === 0,
  );
  const angle = open[Math.floor(rng() * open.length)] ?? 0;
  return { x: tile.x + 0.5, y: tile.y + 0.5, angle };
}
