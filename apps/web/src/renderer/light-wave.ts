// Slow light's lights-out wave (D41): a lamp's light reaches the eye from a lit place after going lamp → place → eye,
// so when the lamps switch, each place shows each lamp as the light now arriving from it left it. The wave table is a
// Lighting like the room's, re-summed from each lamp's own share of the room's tables (bakeShares) wherever what a
// place shows changed. Everything is allocated once per table; a frame allocates nothing.
import type { Point } from '@zoom3d/shared';
import {
  ambientAt,
  bakeShares,
  FIXTURE,
  FLOOR_SUB,
  type Light,
  type LightAtPoint,
  type Lighting,
  pack,
  REFLECTION_LAMPS,
  type ShareSink,
  tint,
  WALL_V,
} from './lighting';
import { RELIEF_LEVELS } from './textures';
import { CEILING, FLOOR } from './walls';

/** The room's light changes, newest first (game/light-timeline.ts). */
export interface LightChanges {
  readonly count: number;
  timeAt(back: number): number;
  lightingAt(back: number): Lighting | null;
}

/** One lit table's lamps, place by place: a floor and ceiling cell's, or a wall sample column's. */
interface Shares {
  /** Per place, its entries' range. */
  start: Int32Array;
  end: Int32Array;
  /** Per place: whether the bake reached it (open floor, a face's sample). */
  reached: Uint8Array;
  /** Per place × 3: its ambient (shaded, for a wall). */
  ambient: Float32Array;
  /** Per place: the path of its brightest lamp, which its ambient (bounce light) is timed by. */
  ambientPath: Float32Array;
  /** Per entry: the lamp, its distance from the place. */
  lamp: Int16Array;
  path: Float32Array;
}

interface CellShares extends Shares {
  floor: Float32Array;
  ceiling: Float32Array;
  fixture: Uint8Array;
}

interface SampleShares extends Shares {
  x: Float32Array;
  y: Float32Array;
  /** Per entry × WALL_V. */
  k: Float32Array;
}

interface TableShares {
  cells: CellShares;
  samples: SampleShares;
}

/** Growable lists for one bake, turned into typed arrays at its end. */
function collectShares(lm: Lighting): TableShares {
  const cellCount = lm.stride * lm.rows;
  const sampleCount = lm.wallLamp.length / REFLECTION_LAMPS;
  const shares = {
    cells: blankShares(cellCount),
    samples: blankShares(sampleCount),
  };
  const cell = { lamp: [] as number[], path: [] as number[], floor: [] as number[], ceiling: [] as number[] };
  const fixture: number[] = [];
  const sample = { lamp: [] as number[], path: [] as number[], k: [] as number[] };
  const sampleX = new Float32Array(sampleCount);
  const sampleY = new Float32Array(sampleCount);
  const brightest = { cell: new Float32Array(cellCount).fill(-1), sample: new Float32Array(sampleCount).fill(-1) };
  const sink: ShareSink = {
    wallAmbient(at, x, y, r, g, b) {
      reach(shares.samples, at, sample.lamp.length, r, g, b);
      sampleX[at] = x;
      sampleY[at] = y;
    },
    wallLamp(at, lamp, path, k) {
      sample.lamp.push(lamp);
      sample.path.push(path);
      let sum = 0;
      for (let v = 0; v < WALL_V; v++) {
        sample.k.push(k[v] as number);
        sum += k[v] as number;
      }
      shares.samples.end[at] = sample.lamp.length;
      noteBrightest(shares.samples, brightest.sample, at, sum, path);
    },
    cellAmbient(at, r, g, b) {
      reach(shares.cells, at, cell.lamp.length, r, g, b);
    },
    cellLamp(at, lamp, path, floor, ceiling, showsFixture) {
      cell.lamp.push(lamp);
      cell.path.push(path);
      cell.floor.push(floor);
      cell.ceiling.push(ceiling);
      fixture.push(showsFixture ? 1 : 0);
      shares.cells.end[at] = cell.lamp.length;
      noteBrightest(shares.cells, brightest.cell, at, floor, path);
    },
  };
  bakeShares(lm, FLOOR, CEILING, sink);
  return {
    cells: {
      ...shares.cells,
      lamp: Int16Array.from(cell.lamp),
      path: Float32Array.from(cell.path),
      floor: Float32Array.from(cell.floor),
      ceiling: Float32Array.from(cell.ceiling),
      fixture: Uint8Array.from(fixture),
    },
    samples: {
      ...shares.samples,
      lamp: Int16Array.from(sample.lamp),
      path: Float32Array.from(sample.path),
      k: Float32Array.from(sample.k),
      x: sampleX,
      y: sampleY,
    },
  };
}

function blankShares(places: number): Omit<Shares, 'lamp' | 'path'> {
  return {
    start: new Int32Array(places),
    end: new Int32Array(places),
    reached: new Uint8Array(places),
    ambient: new Float32Array(places * 3),
    ambientPath: new Float32Array(places),
  };
}

function reach(shares: Omit<Shares, 'lamp' | 'path'>, at: number, entries: number, r: number, g: number, b: number) {
  shares.reached[at] = 1;
  shares.start[at] = entries;
  shares.end[at] = entries;
  shares.ambient[at * 3] = r;
  shares.ambient[at * 3 + 1] = g;
  shares.ambient[at * 3 + 2] = b;
}

function noteBrightest(
  shares: Omit<Shares, 'lamp' | 'path'>,
  brightest: Float32Array,
  at: number,
  amount: number,
  path: number
) {
  if (amount > (brightest[at] as number)) {
    brightest[at] = amount;
    shares.ambientPath[at] = path;
  }
}

export interface LightWave {
  /** Bakes `table`'s lamp shares now, so the wave never waits for them (about as long as its own bake). */
  prepare(table: Lighting): void;
  /** The wave table for `eye` at `now`, from the room's light `changes`; reused from frame to frame. */
  update(changes: LightChanges, eye: Point, now: number, lightSpeed: number): Lighting;
}

/** Most changes a frame looks back over: the timeline's capacity. */
const MAX_CHANGES = 16;
/** A place with more lamp entries than fit a signature is re-summed every frame. */
const SIGNATURE_ENTRIES = 21;

export function createLightWave(): LightWave {
  const shareOf = new Map<Lighting, TableShares>();
  let wave: Lighting | null = null;
  let cellSignature = new Int32Array(0);
  let sampleSignature = new Int32Array(0);
  // This frame's changes, newest first, and how far (tiles) each one's light has gone since.
  const shownAt: (Lighting | null)[] = new Array(MAX_CHANGES).fill(null);
  const reachedTiles = new Float64Array(MAX_CHANGES);
  let changeCount = 0;
  /** This frame's lit tables (with shares), and the one with the most lamps, whose lamp list the wave uses. */
  const litTables: Lighting[] = [];
  let lampsFrom: Lighting | null = null;
  const eyeAt = { x: 0, y: 0 };

  /** Which change a place sees through a light path `tiles` long: the newest its light has had time to bring. */
  const seenChange = (tiles: number) => {
    for (let back = 0; back < changeCount; back++) {
      if (tiles <= (reachedTiles[back] as number)) {
        return back;
      }
    }
    return changeCount - 1;
  };
  const isLit = (t: Lighting | null): t is Lighting => t !== null && t.lights.length > 0;

  const atPoint: LightAtPoint = {
    lampLit(index, x, y) {
      const l = wave?.lights[index] as Light | undefined;
      if (l === undefined) {
        return false;
      }
      const tiles = Math.hypot(x - eyeAt.x, y - eyeAt.y) + Math.hypot(l.x - x, l.y - y);
      const shown = shownAt[seenChange(tiles)] ?? null;
      return shown !== null && index < shown.lights.length;
    },
    ambientInto(x, y, out) {
      const shown = shownAt[seenChange(Math.hypot(x - eyeAt.x, y - eyeAt.y))] ?? null;
      if (shown === null) {
        out.fill(0);
        return;
      }
      ambientAt(shown, x, y, out);
    },
  };

  const createWave = (like: Lighting): Lighting => {
    cellSignature = new Int32Array(like.stride * like.rows).fill(-1);
    sampleSignature = new Int32Array(like.wallLamp.length / REFLECTION_LAMPS).fill(-1);
    return {
      ...like,
      ambient: 0,
      bounce: null,
      wall: Uint32Array.from(like.wall),
      wallLamp: Int16Array.from(like.wallLamp),
      wallLampSeen: Uint8Array.from(like.wallLampSeen),
      floor: Uint32Array.from(like.floor),
      ceiling: Uint32Array.from(like.ceiling),
      floorLamp: Int16Array.from(like.floorLamp),
      floorLampSeen: Uint8Array.from(like.floorLampSeen),
      wave: atPoint,
    };
  };

  /** This frame's changes and lit tables; the wave table, made on the first frame. */
  const takeChanges = (changes: LightChanges, now: number, lightSpeed: number): Lighting | null => {
    changeCount = Math.min(MAX_CHANGES, changes.count);
    litTables.length = 0;
    lampsFrom = null;
    for (let back = 0; back < changeCount; back++) {
      const shown = changes.lightingAt(back);
      shownAt[back] = shown;
      reachedTiles[back] = (lightSpeed * (now - changes.timeAt(back))) / 1000;
      if (isLit(shown) && !litTables.includes(shown)) {
        prepare(shown);
        litTables.push(shown);
        if (lampsFrom === null || shown.lights.length > lampsFrom.lights.length) {
          lampsFrom = shown;
        }
      }
    }
    return lampsFrom ?? shownAt[0] ?? null;
  };

  const prepare = (table: Lighting) => {
    if (!shareOf.has(table)) {
      shareOf.set(table, collectShares(table));
    }
  };

  /** Re-sums floor and ceiling cell `at`, at (x, y), whose ambient comes from the change `ambientBack` shows. */
  const sumCell = (w: Lighting, at: number, dEye: number, ambientBack: number) => {
    const shown = shownAt[ambientBack] ?? null;
    const ambientShares = isLit(shown) ? shareOf.get(shown)?.cells : undefined;
    let fr = ambientShares ? (ambientShares.ambient[at * 3] as number) : 0;
    let fg = ambientShares ? (ambientShares.ambient[at * 3 + 1] as number) : 0;
    let fb = ambientShares ? (ambientShares.ambient[at * 3 + 2] as number) : 0;
    let cr = fr;
    let cg = fg;
    let cb = fb;
    let fixture = false;
    for (const table of litTables) {
      const s = shareOf.get(table)?.cells;
      if (!s) {
        continue;
      }
      for (let e = s.start[at] as number; e < (s.end[at] as number); e++) {
        if (shownAt[seenChange(dEye + (s.path[e] as number))] !== table) {
          continue;
        }
        const l = table.lights[s.lamp[e] as number] as Light;
        const kf = s.floor[e] as number;
        const kc = s.ceiling[e] as number;
        fr += l.r * kf;
        fg += l.g * kf;
        fb += l.b * kf;
        cr += l.r * kc;
        cg += l.g * kc;
        cb += l.b * kc;
        fixture ||= s.fixture[e] === 1;
      }
    }
    w.floor[at] = tint(FLOOR, fr, fg, fb);
    w.ceiling[at] = fixture ? FIXTURE : tint(CEILING, cr, cg, cb);
    copyLamps(w.floorLamp, w.floorLampSeen, shown, shown?.floorLamp, shown?.floorLampSeen, at);
  };

  /** Re-sums wall sample column `at`, its ambient from the change `ambientBack` shows. */
  const sumSample = (w: Lighting, at: number, dEye: number, ambientBack: number) => {
    const shown = shownAt[ambientBack] ?? null;
    const ambientShares = isLit(shown) ? shareOf.get(shown)?.samples : undefined;
    const ar = ambientShares ? (ambientShares.ambient[at * 3] as number) : 0;
    const ag = ambientShares ? (ambientShares.ambient[at * 3 + 1] as number) : 0;
    const ab = ambientShares ? (ambientShares.ambient[at * 3 + 2] as number) : 0;
    const levels = RELIEF_LEVELS.length;
    for (let v = 0; v < WALL_V; v++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const table of litTables) {
        const s = shareOf.get(table)?.samples;
        if (!s) {
          continue;
        }
        for (let e = s.start[at] as number; e < (s.end[at] as number); e++) {
          if (shownAt[seenChange(dEye + (s.path[e] as number))] !== table) {
            continue;
          }
          const l = table.lights[s.lamp[e] as number] as Light;
          const k = s.k[e * WALL_V + v] as number;
          r += l.r * k;
          g += l.g * k;
          b += l.b * k;
        }
      }
      const base = (at * WALL_V + v) * levels;
      for (let level = 0; level < levels; level++) {
        const lift = 1 + (RELIEF_LEVELS.at(level) ?? 0);
        w.wall[base + level] = pack(ar + r * lift, ag + g * lift, ab + b * lift);
      }
    }
    copyLamps(w.wallLamp, w.wallLampSeen, shown, shown?.wallLamp, shown?.wallLampSeen, at);
  };

  /** What place `at` shows: the change its ambient comes from, and which of its lamps' shares are seen lit. */
  const signatureOf = (at: number, dEye: number, ambientBack: number, shares: (t: Lighting) => Shares) => {
    // Which tables are lit matters too: a cell whose lamps light from another table must be re-summed.
    let signature = ambientBack * MAX_CHANGES + litTables.length;
    let entries = 0;
    for (const table of litTables) {
      const own = shares(table);
      for (let e = own.start[at] as number; e < (own.end[at] as number); e++) {
        const lit = shownAt[seenChange(dEye + (own.path[e] as number))] === table ? 1 : 0;
        signature = signature * 2 + lit;
        entries++;
      }
    }
    return entries > SIGNATURE_ENTRIES ? -2 : signature;
  };

  const cellsOf = (t: Lighting) => (shareOf.get(t) as TableShares).cells;
  const samplesOf = (t: Lighting) => (shareOf.get(t) as TableShares).samples;

  return {
    prepare,
    update(changes, eye, now, lightSpeed) {
      const like = takeChanges(changes, now, lightSpeed);
      if (like === null) {
        throw new Error('a light wave needs a lit or dark table');
      }
      eyeAt.x = eye.x;
      eyeAt.y = eye.y;
      wave ??= createWave(like);
      const w = wave;
      w.version = (w.version ?? 0) + 1;
      if (lampsFrom) {
        w.lights = lampsFrom.lights;
        w.portals = lampsFrom.portals;
        w.portalGlowSeen = lampsFrom.portalGlowSeen;
      }
      const first = litTables.at(0);
      if (first === undefined) {
        // Every change in sight is the dark: it shows as it is.
        w.floor.set(like.floor);
        w.ceiling.set(like.ceiling);
        w.wall.set(like.wall);
        w.floorLamp.fill(-1);
        w.wallLamp.fill(-1);
        cellSignature.fill(-1);
        sampleSignature.fill(-1);
        return w;
      }
      const { cells, samples } = shareOf.get(first) as TableShares;
      for (let row = 0; row < w.rows; row++) {
        const y = (row + 0.5) / FLOOR_SUB;
        for (let col = 0; col < w.stride; col++) {
          const at = row * w.stride + col;
          if (cells.reached[at] !== 1) {
            continue;
          }
          const dEye = Math.hypot((col + 0.5) / FLOOR_SUB - eye.x, y - eye.y);
          const ambientBack = seenChange(dEye + (cells.ambientPath[at] as number));
          const signature = signatureOf(at, dEye, ambientBack, cellsOf);
          if (signature !== cellSignature[at] || signature === -2) {
            cellSignature[at] = signature;
            sumCell(w, at, dEye, ambientBack);
          }
        }
      }
      for (let at = 0; at < sampleSignature.length; at++) {
        if (samples.reached[at] !== 1) {
          continue;
        }
        const dEye = Math.hypot((samples.x[at] as number) - eye.x, (samples.y[at] as number) - eye.y);
        const ambientBack = seenChange(dEye + (samples.ambientPath[at] as number));
        const signature = signatureOf(at, dEye, ambientBack, samplesOf);
        if (signature !== sampleSignature[at] || signature === -2) {
          sampleSignature[at] = signature;
          sumSample(w, at, dEye, ambientBack);
        }
      }
      return w;
    },
  };
}

/** Place `at`'s reflection lamps, as `shown` lists them, or none where it shows the dark. */
function copyLamps(
  lamps: Int16Array,
  seen: Uint8Array,
  shown: Lighting | null,
  from: Int16Array | undefined,
  fromSeen: Uint8Array | undefined,
  at: number
): void {
  const base = at * REFLECTION_LAMPS;
  for (let k = 0; k < REFLECTION_LAMPS; k++) {
    const lit = shown !== null && shown.lights.length > 0 && from !== undefined && fromSeen !== undefined;
    lamps[base + k] = lit ? (from[base + k] as number) : -1;
    seen[base + k] = lit ? (fromSeen[base + k] as number) : 0;
  }
}
