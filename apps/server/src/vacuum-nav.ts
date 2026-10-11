// Where the robot vacuum goes (robot vacuum spec §3.3): the map cut into 3×3-tile patches, a coverage route per patch
// (the edge ring first, then back-and-forth lanes) and tile paths between them. Pure; built once per map.
import { type GameMap, hasLineOfSight, isWallAt } from '@zoom3d/shared';

/** Tiles per patch side. */
export const PATCH = 3;
/** Route point spacing in tiles, a little under the robot's width so lanes overlap (tuned for the ~1.5 h full clean). */
export const LANE = 0.6;
/** The robot's collision radius in tiles. */
export const VACUUM_RADIUS = 0.35;
/** How far a route point keeps the robot's centre from a wall. */
const CLEARANCE = VACUUM_RADIUS + 0.01;
/** Route points per patch side. */
const GRID = PATCH / LANE;

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
  /** BFS distances in tiles from the tile containing `from`, indexed by ty * width + tx; -1 for walls and unreached. */
  distances(from: Point): Int32Array;
}

/** Grid positions of the patch's outer ring, clockwise from the top-left corner (y grows down). */
const RING: readonly (readonly [number, number])[] = [
  ...Array.from({ length: GRID }, (_, i) => [i, 0] as const),
  ...Array.from({ length: GRID - 1 }, (_, j) => [GRID - 1, j + 1] as const),
  ...Array.from({ length: GRID - 1 }, (_, i) => [GRID - 2 - i, GRID - 1] as const),
  ...Array.from({ length: GRID - 2 }, (_, j) => [0, GRID - 2 - j] as const),
];

const same = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
const dist2 = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export function createVacuumNav(map: GameMap): VacuumNav {
  const { width, height } = map;
  const cols = Math.ceil(width / PATCH);
  const rows = Math.ceil(height / PATCH);
  const wall = (tx: number, ty: number) => isWallAt(map, tx + 0.5, ty + 0.5);
  const patchOf = (tx: number, ty: number) => Math.floor(ty / PATCH) * cols + Math.floor(tx / PATCH);

  /** The point moved toward its tile's centre until the robot's square body clears every wall around it. */
  const clamp = (x: number, y: number): Point => {
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

  /** Each patch's ring points and inner rows, wall points dropped and the rest clamped. */
  const patches = Array.from({ length: cols * rows }, (_, index) => {
    const ox = (index % cols) * PATCH;
    const oy = Math.floor(index / cols) * PATCH;
    const at = (i: number, j: number): Point | null => {
      const x = ox + LANE / 2 + i * LANE;
      const y = oy + LANE / 2 + j * LANE;
      return wall(Math.floor(x), Math.floor(y)) ? null : clamp(x, y);
    };
    const ring = RING.map(([i, j]) => at(i, j)).filter((p) => p !== null);
    const inner: Point[][] = [];
    for (let j = 1; j < GRID - 1; j++) {
      const row: Point[] = [];
      for (let i = 1; i < GRID - 1; i++) {
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

  const tileIndex = (p: Point) => Math.floor(p.y) * width + Math.floor(p.x);
  const inside = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;

  /** BFS over floor tiles, 4-connected; fills `dist` and `parent` from the tile containing `from`. */
  const bfs = (from: Point, dist: Int32Array, parent: Int32Array | null) => {
    dist.fill(-1);
    if (!inside(from) || wall(Math.floor(from.x), Math.floor(from.y))) {
      return;
    }
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    const start = tileIndex(from);
    dist[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      const at = queue[head++] as number;
      const tx = at % width;
      const ty = (at - tx) / width;
      for (const [nx, ny] of [
        [tx + 1, ty],
        [tx - 1, ty],
        [tx, ty + 1],
        [tx, ty - 1],
      ] as const) {
        const n = ny * width + nx;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || dist[n] !== -1 || wall(nx, ny)) {
          continue;
        }
        dist[n] = (dist[at] as number) + 1;
        if (parent) {
          parent[n] = at;
        }
        queue[tail++] = n;
      }
    }
  };

  const distances = (from: Point) => {
    const dist = new Int32Array(width * height);
    bfs(from, dist, null);
    return dist;
  };

  const path = (from: Point, to: Point): Point[] => {
    const dist = new Int32Array(width * height);
    const parent = new Int32Array(width * height);
    bfs(from, dist, parent);
    if (!inside(to)) {
      return [];
    }
    const start = tileIndex(from);
    let at = tileIndex(to);
    if (dist[at] === -1) {
      return [];
    }
    const out: Point[] = [];
    while (at !== start) {
      out.push({ x: (at % width) + 0.5, y: Math.floor(at / width) + 0.5 });
      at = parent[at] as number;
    }
    return out.reverse();
  };

  const route = (patch: number, from: Point): Point[] => {
    const p = patches[patch];
    if (!p) {
      return [];
    }
    const points: Point[] = [];
    if (p.ring.length > 0) {
      let first = 0;
      for (let i = 1; i < p.ring.length; i++) {
        if (dist2(p.ring[i] as Point, from) < dist2(p.ring[first] as Point, from)) {
          first = i;
        }
      }
      points.push(...p.ring.slice(first), ...p.ring.slice(0, first));
    }
    // Lanes: start with the row nearer to where the ring ended, then snake.
    let last = points.at(-1) ?? from;
    const lanes = [...p.inner];
    const firstY = lanes[0]?.[0]?.y ?? 0;
    const lastY = lanes.at(-1)?.[0]?.y ?? 0;
    if (Math.abs(lastY - last.y) < Math.abs(firstY - last.y)) {
      lanes.reverse();
    }
    for (const lane of lanes) {
      const a = lane[0] as Point;
      const b = lane.at(-1) as Point;
      const row = dist2(b, last) < dist2(a, last) ? [...lane].reverse() : lane;
      points.push(...row);
      last = row.at(-1) as Point;
    }

    // Merge duplicates left by clamping, and path round walls between consecutive points.
    const out: Point[] = [];
    for (const b of points) {
      const a = out.at(-1);
      if (a && same(a, b)) {
        continue;
      }
      if (a && !hasLineOfSight(map, a.x, a.y, b.x, b.y)) {
        out.push(...path(a, b));
      }
      out.push(b);
    }
    return out;
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
