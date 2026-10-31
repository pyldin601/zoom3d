// Where the robot vacuum goes (robot vacuum spec §3.3): the map cut into 3×3-tile patches, a coverage route per patch
// (the edge ring first, then back-and-forth lanes) and tile paths between them. Pure; built once per map.
import { hasLineOfSight } from '../../geometry/los';
import { type GameMap, isWallAt } from '../../map/map';

/** A patch's side. */
const PATCH_TILES = 3;
/** Route point spacing, a little under the robot's width so lanes overlap (tuned for the ~1.5 h full clean). */
const LANE_SPACING_TILES = 0.6;
/** The robot's collision radius in tiles. */
export const VACUUM_RADIUS = 0.35;
/** How far a route point keeps the robot's centre from a wall. */
const CLEARANCE = VACUUM_RADIUS + 0.01;
/** Route points per patch side. */
const POINTS_PER_PATCH_SIDE = Math.round(PATCH_TILES / LANE_SPACING_TILES);
if (Math.abs(POINTS_PER_PATCH_SIDE * LANE_SPACING_TILES - PATCH_TILES) > 1e-9) {
  throw new Error('LANE_SPACING_TILES must divide PATCH_TILES into whole lanes');
}

export interface Point {
  x: number;
  y: number;
}

export interface VacuumNav {
  map: GameMap;
  /** Patch index of tile (tx, ty). */
  patchOf(tx: number, ty: number): number;
  /** Indices of patches with at least one floor tile. */
  dirtyAtStart: readonly number[];
  /** Floor tiles (tile coordinates), for spawning and search destinations. */
  floor: readonly Point[];
  /** Coverage route of a patch, starting from the ring point nearest `from`: edge ring first, then lanes. */
  route(patch: number, from: Point): Point[];
  /** Tile-centre waypoints from the tile containing `from` to the tile containing `to`, excluding the start tile. */
  path(from: Point, to: Point): Point[];
  /** Path distances in tiles from the tile containing `from`, looked up by tile; -1 for walls and unreachable tiles. */
  distances(from: Point): (tile: Point) => number;
}

/** A patch's route points before ordering: its outer ring, clockwise, and its inner rows, top to bottom. */
interface PatchPoints {
  ring: Point[];
  inner: Point[][];
}

/** Grid positions of the patch's outer ring, clockwise from the top-left corner (y grows down). */
const RING: readonly (readonly [number, number])[] = [
  ...Array.from({ length: POINTS_PER_PATCH_SIDE }, (_, i) => [i, 0] as const),
  ...Array.from({ length: POINTS_PER_PATCH_SIDE - 1 }, (_, j) => [POINTS_PER_PATCH_SIDE - 1, j + 1] as const),
  ...Array.from(
    { length: POINTS_PER_PATCH_SIDE - 1 },
    (_, i) => [POINTS_PER_PATCH_SIDE - 2 - i, POINTS_PER_PATCH_SIDE - 1] as const
  ),
  ...Array.from({ length: POINTS_PER_PATCH_SIDE - 2 }, (_, j) => [0, POINTS_PER_PATCH_SIDE - 2 - j] as const),
];

const samePoint = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
const dist2 = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** The ring rotated to start at its point nearest `from` (the first one on a tie). */
function ringFrom(ring: readonly Point[], from: Point): Point[] {
  let first = 0;
  let best = Number.POSITIVE_INFINITY;
  for (const [i, point] of ring.entries()) {
    const d = dist2(point, from);
    if (d < best) {
      first = i;
      best = d;
    }
  }
  return [...ring.slice(first), ...ring.slice(0, first)];
}

/** The inner rows as one back-and-forth sweep: from the end row nearer `from`, each row from its end nearer the last. */
function snakeLanes(rows: readonly Point[][], from: Point): Point[] {
  const lanes = [...rows];
  const firstY = lanes.at(0)?.at(0)?.y ?? 0;
  const lastY = lanes.at(-1)?.at(0)?.y ?? 0;
  if (Math.abs(lastY - from.y) < Math.abs(firstY - from.y)) {
    lanes.reverse();
  }
  const out: Point[] = [];
  let last = from;
  for (const lane of lanes) {
    const start = lane.at(0);
    const end = lane.at(-1);
    const row = start && end && dist2(end, last) < dist2(start, last) ? [...lane].reverse() : lane;
    out.push(...row);
    last = row.at(-1) ?? last;
  }
  return out;
}

export function createVacuumNav(map: GameMap): VacuumNav {
  const { width, height } = map;
  const cols = Math.ceil(width / PATCH_TILES);
  const rows = Math.ceil(height / PATCH_TILES);
  const wall = (tx: number, ty: number) => isWallAt(map, tx + 0.5, ty + 0.5);
  const patchOf = (tx: number, ty: number) => Math.floor(ty / PATCH_TILES) * cols + Math.floor(tx / PATCH_TILES);
  const tileIndex = (p: Point) => Math.floor(p.y) * width + Math.floor(p.x);
  const tileCentre = (index: number): Point => ({ x: (index % width) + 0.5, y: Math.floor(index / width) + 0.5 });
  const inside = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;

  /** The point moved toward its tile's centre until the robot's square body clears every wall around it. */
  const clearOfWalls = (x: number, y: number): Point => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    let cx = x;
    let cy = y;
    if (wall(tx - 1, ty)) {
      cx = Math.max(cx, tx + CLEARANCE);
    }
    if (wall(tx + 1, ty)) {
      cx = Math.min(cx, tx + 1 - CLEARANCE);
    }
    if (wall(tx, ty - 1)) {
      cy = Math.max(cy, ty + CLEARANCE);
    }
    if (wall(tx, ty + 1)) {
      cy = Math.min(cy, ty + 1 - CLEARANCE);
    }
    // A wall only diagonally next to the tile catches the body's corner: step clear along x.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const inCorner =
          Math.floor(cx + sx * VACUUM_RADIUS) === tx + sx && Math.floor(cy + sy * VACUUM_RADIUS) === ty + sy;
        if (inCorner && wall(tx + sx, ty + sy)) {
          cx = sx < 0 ? tx + CLEARANCE : tx + 1 - CLEARANCE;
        }
      }
    }
    return { x: cx, y: cy };
  };

  /** Each patch's route points, by patch index: points on walls dropped, the rest kept clear of walls. */
  const patches = Array.from({ length: cols * rows }, (_, index): PatchPoints => {
    const ox = (index % cols) * PATCH_TILES;
    const oy = Math.floor(index / cols) * PATCH_TILES;
    const at = (i: number, j: number): Point | null => {
      const x = ox + LANE_SPACING_TILES / 2 + i * LANE_SPACING_TILES;
      const y = oy + LANE_SPACING_TILES / 2 + j * LANE_SPACING_TILES;
      return wall(Math.floor(x), Math.floor(y)) ? null : clearOfWalls(x, y);
    };
    const ring = RING.map(([i, j]) => at(i, j)).filter((p) => p !== null);
    const inner: Point[][] = [];
    for (let j = 1; j < POINTS_PER_PATCH_SIDE - 1; j++) {
      const row: Point[] = [];
      for (let i = 1; i < POINTS_PER_PATCH_SIDE - 1; i++) {
        const p = at(i, j);
        if (p) {
          row.push(p);
        }
      }
      if (row.length > 0) {
        inner.push(row);
      }
    }
    return { ring, inner };
  });

  const floor: Point[] = [];
  const dirty = new Set<number>();
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      if (!wall(tx, ty)) {
        floor.push({ x: tx, y: ty });
        dirty.add(patchOf(tx, ty));
      }
    }
  }

  /** BFS over floor tiles, 4-connected; fills `dist` and `parent` (both by tile index) from the tile containing `from`. */
  const bfs = (from: Point, dist: Int32Array, parent: Int32Array | null) => {
    dist.fill(-1);
    if (!inside(from) || wall(Math.floor(from.x), Math.floor(from.y))) {
      return;
    }
    const start = tileIndex(from);
    dist[start] = 0;
    const queue: [index: number, steps: number][] = [[start, 0]];
    // for…of also visits the entries pushed while it runs, so the array works as a FIFO queue.
    for (const [index, steps] of queue) {
      const tx = index % width;
      const ty = (index - tx) / width;
      for (const [nx, ny] of [
        [tx + 1, ty],
        [tx - 1, ty],
        [tx, ty + 1],
        [tx, ty - 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || wall(nx, ny)) {
          continue;
        }
        const next = ny * width + nx;
        if (dist.at(next) !== -1) {
          continue;
        }
        dist[next] = steps + 1;
        if (parent) {
          parent[next] = index;
        }
        queue.push([next, steps + 1]);
      }
    }
  };

  const distances = (from: Point) => {
    const dist = new Int32Array(width * height);
    bfs(from, dist, null);
    return (tile: Point) => (inside(tile) ? (dist.at(tileIndex(tile)) ?? -1) : -1);
  };

  const path = (from: Point, to: Point): Point[] => {
    if (!inside(to)) {
      return [];
    }
    const dist = new Int32Array(width * height);
    const parent = new Int32Array(width * height);
    bfs(from, dist, parent);
    const target = tileIndex(to);
    if (dist.at(target) === -1) {
      return [];
    }
    // Walk the parents back from the target to the start.
    const start = tileIndex(from);
    const out: Point[] = [];
    for (let at: number | undefined = target; at !== undefined && at !== start; at = parent.at(at)) {
      out.push(tileCentre(at));
    }
    return out.reverse();
  };

  /** The points with duplicates (left by clearOfWalls) merged, and a tile path round any wall between two of them. */
  const joinAroundWalls = (points: readonly Point[]): Point[] => {
    const out: Point[] = [];
    for (const b of points) {
      const a = out.at(-1);
      if (a && samePoint(a, b)) {
        continue;
      }
      if (a && !hasLineOfSight(map, a.x, a.y, b.x, b.y)) {
        out.push(...path(a, b));
      }
      out.push(b);
    }
    return out;
  };

  const route = (patch: number, from: Point): Point[] => {
    const points = patches.at(patch);
    if (!points) {
      return [];
    }
    const ring = ringFrom(points.ring, from);
    const lanes = snakeLanes(points.inner, ring.at(-1) ?? from);
    return joinAroundWalls([...ring, ...lanes]);
  };

  return {
    map,
    patchOf,
    dirtyAtStart: [...dirty].sort((a, b) => a - b),
    floor,
    route,
    path,
    distances,
  };
}

/** FNV-1a over the map's size and tiles, as 8 hex chars: tells a saved robot whether its patches still mean anything. */
export function mapFingerprint(map: GameMap): string {
  let h = 0x811c9dc5;
  const feed = (byte: number) => {
    h ^= byte & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const n of [map.width, map.height]) {
    for (let shift = 0; shift < 32; shift += 8) {
      feed(n >>> shift);
    }
  }
  for (const t of map.tiles) {
    feed(t);
  }
  return h.toString(16).padStart(8, '0');
}
