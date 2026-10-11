# Robot Vacuum (first voxel object) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every room gets a server-driven robot vacuum. It's drawn as a voxel model and heard as a synthesised spatial
hum. It cleans the map in 3×3-tile patches over about an hour, then searches for its dock forever.

**Architecture:**
- **Server:** a pure simulation (`apps/server/src/vacuum*.ts`) runs one robot per room in `Lobby` and broadcasts
  `object_state` at 10 Hz. The robot is saved in the restart snapshot.
- **Client, data:** `Session` keeps world objects next to peers, with the same interpolation buffers.
- **Client, picture:** a generic voxel renderer draws them inside the sprite pass, far to near with the discs.
- **Client, sound:** a Web Audio synth plays through a new `AudioEngine.attachNode` spatial path.

**Tech Stack:** TypeScript, Node `ws` server, Canvas2D software renderer, Web Audio, Vitest, Playwright, Biome.

**Spec:** `docs/superpowers/specs/2026-10-11-robot-vacuum-design.md` (read it first; § references below point there).

## Global Constraints

- Code style: Biome (`pnpm exec biome check --write .`). 120 columns, single quotes, semicolons, `es5` trailing commas.
  Every `if`/`else`/`for`/`while` body is a braced block.
- Write a failing test first for logic. Rendering and audio glue are verified by hand or with Playwright.
- No allocations in the per-frame or per-column hot path. Preallocate buffers in module scope, as `sprites.ts` does.
- **The robot is not a `Peer`.**
  - It is never in `welcome.peers`, `peer_*` messages, labels, the automap, `MAX_PEERS`, `LobbyStats` or media.
  - It never keeps a room open.
- **Speeds:**
  - It drives at a true **0.6 tiles/s**. Move it with `moveWithCollision(map, x, y, dx, dy, 0.35)`, never `stepPlayer`.
  - It turns in place at **π/2 rad/s**.
  - Its collision radius is **0.35**.
- The hum is always quieter than a voice at the same distance (§5.3).
- Telemetry privacy is unchanged: no room ids in logs. Nothing new is collected, so `privacy.html` stays as it is.
- Commit after each task with an imperative-mood message ending with the line:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

These are the conditions most likely to bite a real user that no single feature test covers. Each one has a test in
the task named.

1. **Server restart mid-party:** the restored robot's `seq` restarts at 1. A resumed client must not drop its poses
   and freeze it. Covered in Task 6, "a welcome resets object seq".
2. **A person standing still on the robot's route for a long time:** the robot must give up that waypoint and carry
   on. It must not stall or shake forever. Covered in Task 4, "a person parked on a waypoint is skipped".
3. **A patch whose route crosses a wall (an L-shaped patch):** the robot must path round, not grind against the wall
   until it gives up. Covered in Task 3, "an L-shaped patch is cleaned without stalling".
4. **A snapshot from before this change, or from an edited map:** the room restores with a fresh robot and never
   crashes or loses its people. Covered in Task 5, "restore with a missing or mismatched vacuum".
5. **The robot behind a wall or a nearer face:** it must be hidden correctly, and must not bleed through walls or
   draw over a nearer disc. Covered in Task 7, "voxel faces are depth-tested against walls" and "a nearer disc covers
   the robot".

---

### Task 1: Protocol: world objects on the wire

**Files:**
- Modify: `packages/shared/src/protocol/protocol.ts`
- Test: `packages/shared/src/protocol/protocol.test.ts`

**Interfaces:**
- Produces (exported from `@zoom3d/shared`):
  ```ts
  export type ObjectKind = 'vacuum';
  export type ObjectEvent = 'bump' | 'lost';
  export interface ObjectInfo { id: string; kind: ObjectKind; x: number; y: number; angle: number }
  // ServerMessage additions:
  //   welcome gets  objects: ObjectInfo[]
  //   | { type: 'object_state'; id: string; x: number; y: number; angle: number; seq: number; event?: ObjectEvent }
  export function parseObjectInfo(v: unknown): ObjectInfo | null;
  ```

- [ ] **Step 1: Write the failing tests** in a new `describe('world objects')` block:
  - `welcome without objects parses with objects: []`: an existing valid welcome fixture with no `objects` key parses
    to `objects: []`.
  - `welcome keeps valid objects and drops invalid ones`: `objects: [{id:'v',kind:'vacuum',x:1,y:2,angle:0},
    {id:'w',kind:'toaster',x:1,y:2,angle:0}, {id:3}]` parses to just the vacuum, and the welcome is still accepted.
  - `object_state parses with and without event`: `{type:'object_state',id:'v',x:1,y:2,angle:0.5,seq:3}` round-trips.
    The same message with `event:'bump'` keeps `event: 'bump'`.
  - `object_state with an unknown event keeps the pose`: `event:'dance'` parses with no `event` key.
  - `object_state rejects a bad pose or seq`: `x:'1'` gives `null`, and `seq:-1` gives `null`.

- [ ] **Step 2: Run them, expect FAIL**

  Run: `pnpm exec vitest run packages/shared/src/protocol/protocol.test.ts`
  Expected: the new tests fail (no `objects` on welcome, `object_state` returns null).

- [ ] **Step 3: Implement** the types above.
  - `parseObjectInfo` accepts only known kinds.
  - In `parseServerMessage`'s `welcome` case: a missing or non-array `m.objects` becomes `[]`, and entries map through
    `parseObjectInfo` with nulls filtered out.
  - New `object_state` case, using the existing `pose`/`isSeq` helpers. The event is kept only if it's
    `'bump' | 'lost'`.

- [ ] **Step 4: Fix the compile fallout.** The server's `Lobby.welcome` must now send `objects: []`. Add exactly that
  for now; Task 5 fills it in. Session test fixtures that build a welcome need `objects: []`.

  Run: `pnpm typecheck && pnpm exec vitest run packages/shared apps/server apps/web/src/net`
  Expected: all PASS.

- [ ] **Step 5: Commit:** `feat(shared): world objects in the protocol`.

---

### Task 2: Vacuum navigation: patches, routes, paths, map fingerprint

**Files:**
- Create: `apps/server/src/vacuum-nav.ts`
- Test: `apps/server/src/vacuum-nav.test.ts`

**Interfaces:**
- Consumes: `GameMap`, `isWallAt`, `hasLineOfSight` from `@zoom3d/shared`.
- Produces:
  ```ts
  export const PATCH = 3;            // tiles per patch side
  export const LANE = 0.5;           // route point spacing, tiles
  export const VACUUM_RADIUS = 0.35; // tiles
  export interface Point { x: number; y: number }
  export interface VacuumNav {
    map: GameMap;
    /** Patch index of tile (tx, ty): Math.floor(ty / PATCH) * cols + Math.floor(tx / PATCH). */
    patchOf(tx: number, ty: number): number;
    /** Indices of patches with at least one floor tile. */
    dirtyAtStart: readonly number[];
    /** Floor tiles, for spawning and search destinations. */
    floor: readonly Point[];
    /** Coverage route of a patch, starting from the ring point nearest `from`: edge ring first, then lanes. */
    route(patch: number, from: Point): Point[];
    /** BFS over floor tiles: tile-centre waypoints from the tile containing `from` to tile `to` (excluding the start tile). */
    path(from: Point, to: Point): Point[];
    /** BFS distances in tiles from the tile containing `from`, indexed by ty * width + tx; -1 for walls. */
    distances(from: Point): Int32Array;
  }
  export function createVacuumNav(map: GameMap): VacuumNav;
  /** FNV-1a over width, height and tiles, as 8 hex chars. */
  export function mapFingerprint(map: GameMap): string;
  ```

**How a route is built.** This algorithm isn't determined by the tests alone.
1. Patch `(px, py)` covers tiles `[3px, 3px+2] × [3py, 3py+2]`. Its candidate points are a 6×6 grid at
   `3px + 0.25 + 0.5i`, `3py + 0.25 + 0.5j`.
2. Drop points inside wall tiles.
3. Clamp each remaining point so it stays at least `VACUUM_RADIUS + 0.01` from every wall neighbour of its tile. On an
   axis whose neighbour tile is a wall, pull the coordinate toward the tile centre (`tx + 0.36 .. tx + 0.64`).
4. Merge consecutive duplicates.
5. Order: the outer ring of the 6×6 grid comes first, clockwise and rotated to start at the point nearest `from`. Then
   the inner 4×4 in boustrophedon rows, starting with the row nearest the ring's last point.
6. Wherever two consecutive points lack `hasLineOfSight`, splice in `path(a, b)`'s tile centres between them.

- [ ] **Step 1: Write the failing tests** (use `parseMap` inline maps plus `LEVEL1`):
  - `LEVEL1 has 164 dirty patches`: `createVacuumNav(parseMap(LEVEL1)).dirtyAtStart.length === 164`. 54 of them
    are full (verified by a tile count).
  - `a full 3×3 floor patch routes the 20-point ring before the 16 inner points`: on a map with a fully open 3×3 patch,
    the route has 36 points. The first 20 lie on the ring (an x or y coordinate at the patch's 0.25 or 2.75 offset,
    after clamping), and the last 16 don't.
  - `route points keep the robot clear of walls`: for every route point of every LEVEL1 patch,
    `moveWithCollision(map, p.x, p.y, 0, 0, VACUUM_RADIUS)` leaves the point unchanged, and no corner at ±0.35 is inside
    a wall.
  - `route starts at the ring point nearest from`.
  - `consecutive route points always have line of sight` across every LEVEL1 patch, which means the path splicing
    works.
  - `path reaches the target tile centre`, and `distances` agrees with `path().length` on LEVEL1 between spawn and a
    far tile.
  - `mapFingerprint changes when one tile changes` and is stable for the same text.

- [ ] **Step 2: Run, expect FAIL**

  Run: `pnpm exec vitest run apps/server/src/vacuum-nav.test.ts`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createVacuumNav` and `mapFingerprint`** in `apps/server/src/vacuum-nav.ts`. Precompute
  per-patch candidate points once at creation. `route()` only orders and splices them.

- [ ] **Step 4: Run, expect PASS** with the same command.

- [ ] **Step 5: Commit:** `feat(server): vacuum navigation over 3×3 patches`.

---

### Task 3: Vacuum simulation: cleaning, dock search, pace

**Files:**
- Create: `apps/server/src/vacuum.ts`
- Test: `apps/server/src/vacuum.test.ts`

**Interfaces:**
- Consumes: Task 2's `VacuumNav`, `VACUUM_RADIUS`, `Point`. Also `moveWithCollision` and `ObjectEvent`/`ObjectInfo`
  from `@zoom3d/shared`.
- Produces:
  ```ts
  export const VACUUM_SPEED = 0.6;           // tiles/s
  export const VACUUM_TURN_SPEED = Math.PI / 2; // rad/s
  export const SCAN_TURN_SPEED = Math.PI / 4;   // rad/s, the slow searching circle (8 s)
  export const LOST_WAIT_S = 2;
  export const SEARCH_MIN_TILES = 10;
  export type VacuumPhase = 'cleaning' | 'searching';
  export interface Vacuum {
    id: string; x: number; y: number; angle: number; seq: number;
    phase: VacuumPhase;
    /** Patch indices already cleaned. */
    clean: Set<number>;
    /** Waypoints given up on since spawn (for tests and debugging). */
    skipped: number;
    // …plus private plan state of your choosing (current patch, waypoint list, mode, timers)
  }
  export interface VacuumSave { id: string; x: number; y: number; angle: number; phase: VacuumPhase; clean: number[]; map: string }
  export function createVacuum(nav: VacuumNav, rng: () => number, id: string, opts?: { nearlyDone?: boolean }): Vacuum;
  export function restoreVacuum(nav: VacuumNav, save: VacuumSave): Vacuum | null; // null on fingerprint mismatch or a pose in a wall
  export function saveVacuum(nav: VacuumNav, v: Vacuum): VacuumSave;
  /** Advances by dt seconds. `people` are connected persons' positions (Task 4). Returns the event of this step, if any. */
  export function stepVacuum(nav: VacuumNav, v: Vacuum, dt: number, rng: () => number, people: readonly Point[]): ObjectEvent | null;
  export function vacuumInfo(v: Vacuum): ObjectInfo; // kind: 'vacuum'
  ```

**Behaviour (§3).** Use a small mode machine: `turn` → `drive` → next waypoint, plus `pause` and `scan`.
- **Spawn:** `createVacuum` puts the robot at the centre of a random `nav.floor` tile with a random angle, phase
  `cleaning` and nothing clean. With `nearlyDone`, every dirty patch except the spawn tile's own is already in
  `clean`.
- **Choosing a patch:** with no current patch, pick the dirty patch first reached by BFS (`nav.distances`) from the
  robot. The waypoints are `nav.path` to the nearest tile of that patch followed by `nav.route(patch, arrival)`.
- **Moving:** at each waypoint, turn in place toward it at `VACUUM_TURN_SPEED` until within 0.02 rad, then drive at
  `VACUUM_SPEED` with `moveWithCollision(…, VACUUM_RADIUS)`. It arrives within 0.05 tiles.
- **Finishing a patch:** when the patch's last waypoint is reached or skipped, add the patch to `clean`.
- **Give-up:** each waypoint gets a deadline when it becomes current:
  `10 s + distance / VACUUM_SPEED + π / VACUUM_TURN_SPEED`. Past it, the waypoint is skipped. This covers both "blocked
  > 10 s" and "wedged".
- **Searching:** when no dirty patch is left, the phase becomes `searching`, forever:
  1. Drive `nav.path` to a random floor tile whose BFS distance is greater than `SEARCH_MIN_TILES` (the farthest tile
     if there is none).
  2. `scan`: turn 2π at `SCAN_TURN_SPEED`.
  3. Return `'lost'` on the step the scan ends.
  4. `pause` for `LOST_WAIT_S`.
  5. Repeat.
- **Restore:** `restoreVacuum` re-plans from scratch. The patch in progress is not in `clean`, so it is redone.

- [ ] **Step 1: Write the failing tests** (seeded rng as in `bots.test.ts`, step with `dt = 0.1`):
  - `spawns on a floor tile centre, cleaning, nothing clean`.
  - `turns in place before driving`: on the first steps toward a waypoint 90° off, x/y stay put while the angle changes
    by at most `VACUUM_TURN_SPEED * 0.1` per step.
  - `never moves faster than 0.6 tiles/s`: across 2,000 steps, the per-step distance is at most `0.06 + 1e-9`.
  - `cleans the nearest dirty patch first`: on a small two-room map, the first patch added to `clean` is the one
    containing the spawn tile.
  - `an L-shaped patch is cleaned without stalling`: a patch with a wall tile in its middle row is cleaned, with 
    `v.skipped` still at 0.
  - `switches to searching only when every patch is clean`: on a tiny map, step until `phase === 'searching'`. At that
    moment `clean.size === nav.dirtyAtStart.length`, and it was never `searching` before.
  - `searching emits lost after each scan and never ends`: after the switch, step 10 minutes of sim time. At least 3
    `'lost'` events, the phase stays `searching`, and positions stay off walls.
  - `nearlyDone leaves exactly one dirty patch`.
  - `save → restore round-trips pose, phase and clean set`. A different map fingerprint gives `null`, and so does a
    pose inside a wall.
  - **`a full LEVEL1 clean takes 50 min – 2 h`**: fast-forward `stepVacuum` with dt 0.1 and no people until
    `phase === 'searching'`. The elapsed sim time `t` satisfies `50 * 60 <= t && t <= 120 * 60`. Log `t` with
    `console.info` so the number is visible. If it falls outside, tune `LANE` or turn handling, not the spec speeds.

- [ ] **Step 2: Run, expect FAIL**

  Run: `pnpm exec vitest run apps/server/src/vacuum.test.ts`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `apps/server/src/vacuum.ts` per the behaviour above. Reuse one scratch object for movement
  results; this runs 10×/s per room.

- [ ] **Step 4: Run, expect PASS.** Record the pace test's logged minutes in the commit message body.

- [ ] **Step 5: Commit:** `feat(server): robot vacuum cleans patch by patch, then searches for its dock`.

---

### Task 4: Vacuum simulation: bumping into people

**Files:**
- Modify: `apps/server/src/vacuum.ts`
- Test: `apps/server/src/vacuum.test.ts`

**Interfaces:**
- Consumes: `PLAYER_RADIUS` from `@zoom3d/shared`.
- Produces: `export const BUMP_PAUSE_S = 0.3; export const SIDESTEP = 0.6;`. `stepVacuum` now uses `people`.

**Behaviour (§3.4)**
- **When it counts:** only while in `drive`. A bump is a person within `VACUUM_RADIUS + PLAYER_RADIUS` (0.6) of the
  centre and in front: `dot(heading, person - robot) > 0`.
- **On a bump:**
  1. Return `'bump'`.
  2. Pause `BUMP_PAUSE_S`.
  3. Turn 90° away from the person: to the side opposite the sign of `cross(heading, person - robot)`. If the sidestep
     point on that side, `robot + SIDESTEP * sideDir`, is inside a wall (`isWallAt`), use the other side.
  4. Insert the sidestep point as a waypoint before the current one, then carry on.
- **The waypoint deadline from Task 3 keeps running** through bumps, so repeat bumps end in a skip.

- [ ] **Step 1: Write the failing tests:**
  - `bumps a person ahead and sidesteps`: in an open room, the robot drives toward a person 1 tile ahead. Expect
    exactly one `'bump'` event when the gap closes, then it stands still for ≈0.3 s (±0.1). Then its angle changes by
    ≈π/2 and it ends up having passed the person, with its x beyond the person's x within 15 s.
  - `ignores people behind it and people beside it beyond 0.6`.
  - `a person parked on a waypoint is skipped`: a person stands exactly on the robot's next route point and never
    moves. Within 20 s the waypoint is skipped (`v.skipped` +1), and the robot reaches the following waypoint.
  - `never bumps while turning or paused`.

- [ ] **Step 2: Run, expect FAIL**

  Run: `pnpm exec vitest run apps/server/src/vacuum.test.ts`
  Expected: the new bump tests fail.

- [ ] **Step 3: Implement** in `stepVacuum`.

- [ ] **Step 4: Run, expect PASS**, including Task 3's pace test. Bumps don't occur there because it has no people.

- [ ] **Step 5: Commit:** `feat(server): the vacuum bumps into people and drives around them`.

---

### Task 5: Lobby and server: one robot per room, ticking, snapshot, dev shortcut

**Files:**
- Modify: `apps/server/src/lobby.ts` (options, `join`, `welcome`, `tick`, `stepBots` → `stepWorld`, `snapshot`,
  `restore`)
- Modify: `apps/server/src/snapshot.ts` (`parseSnapshot`)
- Modify: `apps/server/src/server.ts` (`ServerOptions`, Lobby construction, the 100 ms interval)
- Modify: `apps/server/src/main.ts` (env)
- Test: `apps/server/src/vacuum-lobby.test.ts` (new, harness copied from `bots.test.ts`),
  `apps/server/src/snapshot.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 (`createVacuumNav`, `createVacuum`, `stepVacuum`, `saveVacuum`, `restoreVacuum`, `vacuumInfo`,
  `VacuumSave`).
- Produces:
  - `LobbyOptions.vacuum?: boolean`: default `false`, so existing lobby tests are untouched.
  - `LobbyOptions.vacuumNearlyDone?: boolean`.
  - `LobbySnapshot.rooms[i].vacuum?: VacuumSave`, still `version: 1`.
  - `Lobby.stepWorld(dtMs)` replaces `stepBots`. Update `bots.test.ts` call sites.
  - `ServerOptions.vacuum?: boolean` (default `true`) and `ServerOptions.vacuumNearlyDone?: boolean`.

**Wiring**
- **Storage:** `private vacuums = new Map<string, Vacuum>()` keyed by room id. Create `nav` lazily, once per lobby,
  like `floor`.
- **Spawning:** in `join`, when `room.size === 0` and `opts.vacuum`, create the robot with
  `createVacuum(nav, rng, newToken(), { nearlyDone })`. In `restore`, use `restoreVacuum` if the snapshot has one,
  else create a fresh robot.
- **Welcome:** `objects: vacuum ? [vacuumInfo(vacuum)] : []`.
- **Room close:** `tick()` deletes the room's vacuum when it deletes the room.
- **`stepWorld`:**
  1. Run the existing bot stepping.
  2. Then, for each room with at least one connected person, compute `people` from connected non-bot peers'
     positions.
  3. Call `stepVacuum`, `v.seq++`, and broadcast to the room's connections
     `{type:'object_state', id, x, y, angle, seq, ...(event ? {event} : {})}`.
  4. Rooms with nobody connected are frozen.
- **Snapshot:** `snapshot()` adds `vacuum: saveVacuum(nav, v)` per room. `parseSnapshot` validates `r.vacuum`:
  - `id` and `map` are strings
  - `x`, `y`, `angle` are finite
  - `phase` is `'cleaning' | 'searching'`
  - `clean` is an array of non-negative integers

  If it's invalid, omit it and keep the room.
- **Server:** `server.ts` passes `vacuum: opts.vacuum ?? true` and `vacuumNearlyDone`. The interval calls
  `lobby.stepWorld(BOT_TICK_MS)`; rename the constant `WORLD_TICK_MS`.
- **Env:** `main.ts` sets `vacuumNearlyDone: process.env.NODE_ENV !== 'production' && process.env.VACUUM_NEARLY_DONE
  === '1'`.

- [ ] **Step 1: Write the failing tests** in `vacuum-lobby.test.ts` (with `vacuum: true`):
  - `the first join creates one vacuum, listed in every welcome`: A and then B both get the same `objects[0].id` with
    `kind: 'vacuum'`, and no vacuum appears in `peers`.
  - `stepWorld broadcasts object_state with rising seq to connected people only`.
  - `a room with nobody connected freezes its vacuum`: disconnect everyone, step, and expect no `object_state` and an
    unchanged pose.
  - `the vacuum never keeps a room open and is gone with it`: after grace, the room closes. A new join to the same id
    gets a different vacuum id.
  - `bumps people but not bots`: in a `?bots` room, a bot placed in front causes no bump, and a connected person in
    front does.
  - `snapshot carries the vacuum and restore brings it back`: step for a while, snapshot, restore into a new lobby.
    The welcome after resume shows the same id and pose.
  - `restore with a missing or mismatched vacuum` gives a fresh vacuum, and the room and its peers are restored
    intact. Cover both the snapshot without `vacuum` and the one with `map: 'deadbeef'`.
  - In `snapshot.test.ts`: `parseSnapshot keeps a valid vacuum and drops an invalid one but keeps the room`.

- [ ] **Step 2: Run, expect FAIL**

  Run: `pnpm exec vitest run apps/server`
  Expected: the new tests fail.

- [ ] **Step 3: Implement** the wiring above.

- [ ] **Step 4: Run all server tests and typecheck**

  Run: `pnpm exec vitest run apps/server && pnpm typecheck`
  Expected: PASS, including the unchanged `lobby.test.ts`, `server.test.ts` and `bots.test.ts` (renamed call only).

- [ ] **Step 5: Commit:** `feat(server): every room gets a robot vacuum that survives restarts`.

---

### Task 6: Client session: world objects

**Files:**
- Modify: `apps/web/src/net/session.ts`
- Test: `apps/web/src/net/session.test.ts`

**Interfaces:**
- Consumes: Task 1's `ObjectInfo`, `ObjectEvent` and `object_state`.
- Produces:
  ```ts
  export interface RemoteObject { info: ObjectInfo; buffer: SnapshotBuffer; lastSeq: number }
  // Session gains:            objects: Map<string, RemoteObject>
  // SessionListener gains:    objectEvent?(id: string, event: ObjectEvent): void
  /** Key of an object in shared position/audio maps, never colliding with a peer id. */
  export const objectKey = (id: string) => `object:${id}`;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `welcome fills objects with a buffered pose`.
  - `object_state updates the pose and drops stale seq`.
  - `a welcome resets object seq`: an object at seq 50, then a second welcome with the same object id. A following
    `object_state` with seq 1 is applied, simulating the server restart.
  - `object_state with an event calls listener.objectEvent once, after applying the pose`.
  - `object_state for an unknown id is ignored`.

- [ ] **Step 2: Run, expect FAIL**

  Run: `pnpm exec vitest run apps/web/src/net/session.test.ts`

- [ ] **Step 3: Implement**, mirroring `addPeer` and the `peer_state` case. A welcome does `objects.clear()` and then
  adds each one with `lastSeq: -1`.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit:** `feat(web): the session tracks world objects`.

---

### Task 7: Voxel renderer and the vacuum model

**Files:**
- Create: `apps/web/src/renderer/voxels.ts` (model building, face extraction, `renderVoxel`)
- Create: `apps/web/src/renderer/models/vacuum.ts` (`VACUUM_MODEL`)
- Modify: `apps/web/src/renderer/sprites.ts`: an optional `voxels` argument to `renderSprites`, interleaved far to
  near; export `EYE_HEIGHT`, `MIN_DEPTH` and `renderShadow`.
- Modify: `apps/web/src/renderer/walls.bench.ts`
- Test: `apps/web/src/renderer/voxels.test.ts`, `apps/web/src/renderer/models/vacuum.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface VoxelModel {
    /** Voxel edge in tiles. */
    voxel: number;
    /** Exposed faces: 4 corners × (x, y, z) in tiles, model space (+x = front, +z = up, origin = footprint centre on the floor). */
    corners: Float32Array; // length faceCount * 12
    /** Unit normal per face (x, y, z), model space. */
    normals: Float32Array; // length faceCount * 3
    /** Packed rgb() colour per face, already shaded by its normal. */
    colors: Uint32Array;
    faceCount: number;
    /** Floor shadow radius in tiles (half the footprint's larger side). */
    shadowRadius: number;
  }
  /** `color(x, y, z)` returns a packed rgb() or 0 for empty; grid is sx × sy × sz voxels. */
  export function buildModel(sx: number, sy: number, sz: number, voxel: number, color: (x: number, y: number, z: number) => number): VoxelModel;
  export interface VoxelInstance { model: VoxelModel; x: number; y: number; angle: number }
  /** Draws one instance, depth-tested per pixel column against fb.zbuffer; allocation-free. */
  export function renderVoxel(fb: Framebuffer, p: PlayerState, v: VoxelInstance): void;
  /** Camera depth of the instance's centre (same measure as projectSprite's depth), or -1 when behind. */
  export function voxelDepth(fb: Framebuffer, p: PlayerState, v: VoxelInstance): number;
  // sprites.ts
  export function renderSprites(fb, p, sprites, facts?, voxels?: readonly VoxelInstance[]): void;
  // models/vacuum.ts
  export const VACUUM_MODEL: VoxelModel;
  ```

**Shading (my call, §2):** the face colour is the voxel colour × `1.0` for top faces, `0.8` for ±x and `0.62` for ±y.
This is object-relative, as in the approved mockup. Bottom faces are never exposed to the eye-height camera; drop them.

**Projection:** match `projectSprite`. For a world point `(wx, wy, wz)`:
- camera `lateral` and `depth` as in `projectSprite`
- `screenX = w/2 * (1 + lateral/depth)`
- `screenY = h/2 + proj * (EYE_HEIGHT - wz) / depth`, with `proj = w / 2 / tan(fov/2)`

**`renderVoxel` per face:**
1. Rotate and translate the corners. World heading `(cos a, sin a)` maps model +x, and model +y maps to
   `(-sin a, cos a)`.
2. Back-face cull: `dot(worldNormal, camera(p.x, p.y, EYE_HEIGHT) - corner0) <= 0` means skip.
3. Skip the face if any corner's depth is below `MIN_DEPTH`.
4. Compute the face's mean depth.
5. Sort the visible faces far to near using module-level preallocated arrays, grown only when a model needs more.
6. Scan-fill each convex quad, sampling pixel centres. Write the pixel only when `faceDepth < zbuffer[col]`.

**Interleave in `renderSprites`:**
- **Shadows:** draw voxel shadows in the shadow pass with `renderShadow(fb, p, v.x, v.y, depth, model.shadowRadius,
  1)`.
- **Order:** sort the voxels by `voxelDepth`, descending. While walking the discs far to near, first draw every
  pending voxel deeper than the disc. After the loop, draw the rest.
- **Facts:** voxels don't touch `facts`.

**Vacuum model (§2):** a 14 × 14 × 4 grid at `voxel = 0.05`. This is the shape and colour rule from the approved
mockup (`R = 7`, model `x` toward the front):

```ts
// dx, dy from the footprint centre; r = hypot(dx, dy)
const dx = x + 0.5 - 7, dy = y + 0.5 - 7, r = Math.hypot(dx, dy);
const inside = (dx >= 3 ? Math.abs(dy) < 7 : r < 7) && dx <= 5.5; // D-shape: flat front
if (!inside) return 0;
if (z === 0) return rgb(0x3c, 0x32, 0x2d);                                  // skirt
if (dx > 4.5 && z === 2 && (Math.abs(dy - 2.5) < 1 || Math.abs(dy + 2.5) < 1)) return rgb(0xff, 0xff, 0xd2); // eyes
if (dx > 4.5 && (z === 1 || z === 2)) return rgb(0x46, 0x46, 0x4b);         // bumper
if (z === 3) return r < 3.2 ? rgb(0xfa, 0xd2, 0x50) : rgb(0xf5, 0x8c, 0x37); // top: yellow centre, light orange
return rgb(0xe8, 0x78, 0x28);                                                 // body
```

The grid origin maps to model space as `(x - 7) * voxel`, `(y - 7) * voxel`, `z * voxel`, so the model is centred on
its footprint.

- [ ] **Step 1: Write the failing tests:**
  - `buildModel exposes only faces with an empty neighbour`: a 2×1×1 solid gives 8 non-bottom faces (2 top + 6 sides),
    and the shared inner faces are absent.
  - `face colours are shaded 1.0 / 0.8 / 0.62 by normal`.
  - `the vacuum is 0.7 × 0.7 × 0.2 tiles and flat at the front`: across `VACUUM_MODEL.corners`, max z is 0.2, the y
    extent is ±0.35, max x is `6 * 0.05`, and min x is −0.35.
  - `the vacuum's eyes face +x`: some face with normal +x has the shaded eye colour (cream × 0.8).
  - `renderVoxel draws a vacuum 2 tiles ahead below the horizon`: on a 640×360 fb with `zbuffer.fill(Infinity)`, some
    pixel changes, and every changed pixel row is ≥ 180.
  - `voxel faces are depth-tested against walls`: the same setup with `zbuffer.fill(1)` changes no pixel.
  - `a nearer disc covers the robot`: one `Sprite` at depth 1.5 and the robot at depth 2.5, on the same line of sight.
    The disc's centre pixel shows the disc colour, not robot colours. The robot at 1.5 and the disc at 2.5 shows robot
    colours at the overlap.
  - `turning the robot changes what is drawn`: angle 0 vs π/2 give different pixel sets.

- [ ] **Step 2: Run, expect FAIL**

  Run: `pnpm exec vitest run apps/web/src/renderer`

- [ ] **Step 3: Implement** `voxels.ts`, `models/vacuum.ts` and the `renderSprites` change. `landing-scene.ts` keeps
  calling `renderSprites` without voxels.

- [ ] **Step 4: Run the tests (PASS), then add the bench.** The bench is `'renderWalls + 7 face avatars + vacuum'`: the
  existing 7-sprite setup plus `[{ model: VACUUM_MODEL, x: cx + 1.2, y: cy, angle }]`.

  Run: `pnpm bench`
  Expected: the new bench runs. Its mean is within about 15% of `walls+7 sprites`; note both numbers in the commit body.
  If it's far over, profile the face loop before moving on.

- [ ] **Step 5: Commit:** `feat(web): voxel objects in the renderer, starting with the robot vacuum`.

---

### Task 8: Audio: node sources in the engine and the vacuum synth

**Files:**
- Modify: `apps/web/src/audio/engine.ts`: `attachNode`; the analyser becomes optional in `Voice`
- Modify: `apps/web/src/audio/fake-audio.ts`: add `createBufferSource` (with `buffer`, `loop`, `start`, `stop`), and
  `type` on biquads already exists
- Create: `apps/web/src/audio/vacuum-sound.ts`
- Create: `apps/web/src/audio/object-sounds.ts`
- Test: `apps/web/src/audio/engine.test.ts`, `apps/web/src/audio/vacuum-sound.test.ts`,
  `apps/web/src/audio/object-sounds.test.ts`

**Interfaces:**
- Consumes: Task 6's `RemoteObject`, `objectKey` and `ObjectEvent`.
- Produces:
  ```ts
  // engine.ts — AudioEngine gains:
  /** A synthesised source played from `owner`'s position through the voice path; no analyser, never "speaking". */
  attachNode(key: string, node: AudioNode, owner?: string): void;
  // vacuum-sound.ts
  export const VACUUM_GAIN = 0.04; // master level: ≈ −28 dB, well under speech (§5.3); tune by ear in Task 9
  export type Motion = 'drive' | 'turn' | 'still';
  export function motionOf(prev: PlayerState, cur: PlayerState, dtSeconds: number): Motion;
  export interface VacuumSound { output: AudioNode; setMotion(m: Motion): void; bump(): void; lost(): void; dispose(): void }
  export function createVacuumSound(ctx: BaseAudioContext): VacuumSound;
  // object-sounds.ts
  export interface ObjectSounds {
    /** Starts sounds for new objects, stops those gone, updates motion from poses (keyed by objectKey). */
    sync(objects: ReadonlyMap<string, RemoteObject>, poses: ReadonlyMap<string, PlayerState>, dtSeconds: number): void;
    event(id: string, e: ObjectEvent): void;
  }
  export function createObjectSounds(ctx: BaseAudioContext, engine: AudioEngine): ObjectSounds;
  ```

**The synth (§5): variant B "soft purr", as picked by ear in the brainstorm's `hum.html`. Copy these values; only the
level is tuned later:**

| Part | Signal chain |
|---|---|
| Noise | One 2 s mono white-noise `AudioBuffer`, looped through a single `AudioBufferSourceNode` |
| Airflow | noise → bandpass 900 Hz (Q 0.5) → gain 0.45 |
| Brush | noise → lowpass 250 Hz → gain whose `gain` is 0.5 ± 0.3, modulated by an 8 Hz sine LFO |
| Motor | triangle 110 Hz → lowpass 500 Hz → gain 0.45; a 0.25 Hz sine LFO adds ±2 Hz to its frequency |

- **Mixing:** all three layers go into a `motion` gain, then a master gain of `VACUUM_GAIN`, which is the `output`.
- **`setMotion`:** glides with `setTargetAtTime` (τ 0.15 s):

  | Motion | Motor | Motion gain |
  |---|---|---|
  | drive | 110 Hz | 1 |
  | turn | 99 Hz | 0.85 |
  | still | 91 Hz | 0.7 |

- **`bump()`:**
  - The motor dips to 86 Hz and glides back (`setTargetAtTime` τ 0.08 s, starting at +0.05 s).
  - A 70 Hz sine thud with a 4 ms attack decays to silence in 0.15 s.
  - A new oscillator is started per bump, stopped at +0.3 s and connected before the master gain.
- **`lost()`:** two sine beeps, 880 Hz at +0 s then 660 Hz at +0.43 s, each 0.18 s long, into the master gain.
- **Everything goes through the master gain,** so it's spatial at the same level.

**`motionOf`:**
- `drive` when the distance/dt is above 0.2 tiles/s.
- Otherwise `turn` when the shortest-arc |Δangle|/dt is above 0.3 rad/s.
- Otherwise `still`.
- A dt of 0 or less gives `still`.

- [ ] **Step 1: Write the failing tests:**
  - **engine:**
    - `attachNode wires node → lowpass → dry/panner + send/reverb with no analyser`.
    - `a node source gets the same distance gains as a voice`: at distance 3, dry equals
      `voiceGains(3, false, DEFAULT).dry`.
    - `a node source is never speaking`.
    - `occlusion muffles a node source` (WALLED map).
    - `detach disconnects a node source`.
  - **vacuum-sound:**
    - `output is the master gain at VACUUM_GAIN`.
    - `VACUUM_GAIN is at least 12 dB under unity`: `20 * Math.log10(VACUUM_GAIN) <= -12`.
    - `the noise source loops and starts`.
    - `setMotion('turn') targets 99 Hz on the motor`.
    - `bump starts and schedules the stop of a thud oscillator`.
    - `lost schedules two beeps 880 then 660`.
    - `dispose stops sources and disconnects`.
  - **motionOf:** drive, turn and still cases, plus the shortest-arc wrap (from 6.2 to 0.1 rad is a small turn) and
    dt 0.
  - **object-sounds:**
    - `sync attaches one sound per vacuum under objectKey(id)`.
    - `sync detaches and disposes sounds for objects gone`, i.e. a server restart that brings a new id.
    - `event('bump') reaches that object's sound`.
    - `motion follows pose deltas`.

- [ ] **Step 2: Run, expect FAIL**

  Run: `pnpm exec vitest run apps/web/src/audio`

- [ ] **Step 3: Implement.** `attachNode` shares the chain-building code with `attach`; extract a helper instead of
  duplicating it. In `update`, skip the analyser when it's absent.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit:** `feat(web): a synthesised spatial hum for the robot vacuum`.

---

### Task 9: Wire it into the room, verify by hand and by e2e, update docs

**Files:**
- Modify: `apps/web/src/main.ts`
- Create: `apps/web/e2e/vacuum.spec.ts`
- Modify: `docs/open-decisions.md`, `docs/vision.md`, `AGENTS.md`

**Interfaces:**
- Consumes: Task 6 (`session.objects`, `objectKey`, `listener.objectEvent`), Task 7 (`VoxelInstance`, `VACUUM_MODEL`,
  `renderSprites(…, voxels)`) and Task 8 (`createObjectSounds`).

**`main.ts` changes**
- **`refreshPositions`:**
  - Also samples each `session.objects` entry at `now - INTERP_DELAY_MS` into a module-level
    `objectPoses: Map<string, PlayerState>`, keyed by `objectKey(id)` with reused objects.
  - Puts the same objects into `positions` under the same key.
  - Its deletion loop must keep `object:` keys that are still in `session.objects`. Today it deletes every key not in
    `s.peers`.
  - `updateInterest` already ignores non-peer keys (`s.peers.has(id)`). Confirm this and leave it.
- **Frame:** a module-level `voxels: VoxelInstance[]` is refilled each frame from `objectPoses`, reusing instance
  objects, with `model: VACUUM_MODEL`. Pass it as `renderSprites(fb, player, sprites, facts, voxels)`.
- **`joinRoom`:**
  - `objectSounds = createObjectSounds(audioCtx, audio)`.
  - The session listener becomes `{ ...withRoomTracker(…), objectEvent: (id, e) => objectSounds?.event(id, e) }`.
- **Sound sync:** call `objectSounds?.sync(session.objects, objectPoses, dt)` in the frame after `refreshPositions`,
  and in the hidden ticker too (pass `HIDDEN_TICK_MS / 1000` from `./audio/ticker`), so the hum follows the robot while
  the tab is hidden.
- **Dev hook:** `__game` already exposes `session`, so the e2e can read `session.objects`.

**Steps**
- [ ] **Step 1: Write the e2e.** `vacuum.spec.ts`: `'a new party has one robot vacuum that moves'`. Start a party and
  `joinAs(page, 'Ada')`, then poll `__game.session.objects.size` until it's 1. Read the robot's `info.x/y`, then
  `expect.poll` until `Math.hypot(Δx, Δy) > 0.3` within 10 s. Model it on `bots.spec.ts`.

- [ ] **Step 2: Implement the `main.ts` wiring above.**

- [ ] **Step 3: Run the checks**

  Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`
  Expected: all PASS, including `frame-rate.spec.ts` (the robot must not cost frame rate).

- [ ] **Step 4: Verify by hand with the dev server**, starting it with `VACUUM_NEARLY_DONE=1`. Use the `pnpm dev`
  server config or env.
  1. Join a party and find the robot by ear.
  2. Check that the hum is panned and louder near it, and muffled behind a wall.
  3. Stand in its way and check it bumps (thud), turns and drives round you.
  4. Talk with a second tab while standing beside it. Your voice must sit clearly above the hum; tune `VACUUM_GAIN`
     and the layer gains if not.
  5. Wait for the last patch to finish and check it starts wandering, with a slow circle and two sad beeps, again and
     again.
  6. Take a screenshot of the robot next to a face disc for the PR.

- [ ] **Step 5: Update the docs:**
  - **`open-decisions.md`:** add **D22: Voxel objects and the robot vacuum** under *Resolved (2026-10-11)*, linking
    the spec. Record that world objects are server-driven, per room and separate from peers, and that models are
    described in code. Record that the robot reacts to people but not bots, that people walk through it, and that it
    is always quieter than voices.
  - **`vision.md` Non-goals:** "Ambient world objects (like the robot vacuum) are in; interactive map elements are
    still out."
  - **`AGENTS.md` Gotchas:** world objects (`object_state`, `session.objects`, `objectKey`) are not peers: no labels,
    automap, `MAX_PEERS` or media. The vacuum is in the state file, keyed by a map fingerprint. Its hum goes through
    `AudioEngine.attachNode`, not a `MediaStream`. `VACUUM_NEARLY_DONE=1` (non-production) starts it one patch from
    done.

- [ ] **Step 6: Commit:** `feat(web): the robot vacuum appears and hums in every room`, plus
  `docs: record the robot vacuum`.
