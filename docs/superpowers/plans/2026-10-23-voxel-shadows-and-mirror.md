# Voxel shadows and floor mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voxel objects (vacuum, ball) cast soft per-lamp shadows on the floor that also block the floor's lamp
reflections, and show up blurred and faint, mirrored in the floor; the round contact shadow goes.

**Architecture:** Both features run in `renderWalls`' lit path, before the floor is drawn over. Shadows patch per-frame
copies of the baked floor tables (floor colour and `floorLampSeen`), down the path the avatar glow already uses. The
mirror projects each object upside down into a scratch buffer, box-blurs it, and mixes it over the floor pixels. Models
gain bottom faces and a top-down height field.

**Tech Stack:** TypeScript, vitest, Biome; software renderer in `apps/web/src/renderer`; `pnpm bench:walls` /
`pnpm bench:sprites` (esbuild bundles) for perf and pixel hashes.

**Spec:** `docs/superpowers/specs/2026-10-23-voxel-shadows-and-mirror-design.md`

## Global Constraints

- No allocations per frame or per column: scratch arrays are sized once and grown only when the frame or a model needs
  more (`AGENTS.md`).
- Code style per `AGENTS.md` and `docs/code-style.md`: Biome (120 cols, single quotes, semicolons, es5 commas), braced
  bodies, `.at()` over `arr[i] as T` where it isn't a measured hot loop, names with units, comments say only why,
  no "you/your" in identifiers, comments or test titles.
- Compare frames with `firstDifference` (`renderer/test-helpers.ts`), never `toEqual` on whole frames.
- Lamp disc radius is the bake's `LAMP_RADIUS` (0.18 tiles); floor cells are `FLOOR_SUB` (8) per tile.
- Shadows only in lit rooms with lamps on (not reflection mode `'only'`); none in unlit mode, none where no lamp reaches.
- Mirror only in reflection modes `'both'` and `'only'`; distance fade `1 − (d / REFLECTION_RANGE)²`.
- Shadows touch the floor only: never walls, ceiling, people or other objects; the ceiling's reflection keeps the baked
  `floorLampSeen`.
- Avatars are unchanged: round shadow kept, no lamp shadows, no mirror.
- Prove refactors pixel-identical with `pnpm bench:walls` / `pnpm bench:sprites` hashes.

## Review Focus

1. An object crossing the edge of a lamp's reach, or moving a little: its shadow must change smoothly, never pop on or
   off (pinned in Task 3: small steps change any floor pixel by at most a few levels).
2. An object against a wall: no shadow on wall tiles, no mirror on wall pixels or through a wall (Task 3, Task 4).
3. An object right under a lamp (horizontal distance ≈ 0): a shadow under it, no NaN or blank frame (Task 2).
4. An object behind the eye or off the frame's edge whose shadow lies in view: the shadow still shows (Task 3).
5. A cell shaded by two objects from one lamp, and a cell both shaded and lit by an avatar's glow: never darker than
   the lamp-less floor, and the glow still shows on it (Task 3).

---

### Task 1: Bottom faces and the height field on voxel models

**Files:**
- Modify: `apps/web/src/renderer/voxels.ts` (FACES, `VoxelModel`, `buildModel`)
- Modify: `apps/web/src/renderer/lighting.ts:874-905` (`DIR_BOTTOM`, `directLight`)
- Test: `apps/web/src/renderer/voxels.test.ts`, `apps/web/src/renderer/models/ball.test.ts`

**Interfaces:**
- Produces:
  - `export const DIR_BOTTOM = 5` in `lighting.ts`; `directLight` fills 6 directions (`out` length `6 * 3`), bottom
    gets `k * Math.max(0, -dz / dist)`.
  - `VoxelModel` gains `sizeX: number; sizeY: number` (grid cells along model x and y) and
    `tops: Float32Array` (length `sizeX * sizeY`, index `y * sizeX + x`, the height in tiles of the top of the highest
    filled voxel in that column, 0 for an empty column). `shadowRadius` stays until Task 3 removes it.
  - FACES gains a sixth entry, the bottom: normal `[0, 0, -1]`, shade `SHADE_BOTTOM = 0.5`, corners on the unit cube's
    z = 0 face going round the quad.

- [ ] **Step 1: Write the failing tests** in `voxels.test.ts`

Replace the test 'exposes only faces with an empty neighbour, never the bottom' with:
```ts
test('exposes only faces with an empty neighbour, the bottom included', () => {
  const m = buildModel({ x: 2, y: 1, z: 1 }, 0.1, () => RED);
  // 2 tops + 2 bottoms + 1 front + 1 back + 2 left + 2 right; the shared inner faces are absent.
  expect(m.faceCount).toBe(10);
});
test('shades the bottom 0.5', () => { /* byNormal.get('0,0,-1') === scaled(RED, 0.5) */ });
test('keeps each column’s top height', () => {
  // 2 × 1 × 3 grid, voxel 0.1: column x=0 filled at z=0..2, column x=1 only at z=0.
  // expect sizeX 2, sizeY 1, tops ≈ [0.3, 0.1]
});
test('the eye never sees a bottom face', () => {
  // renderVoxel a 1×1×1 cube of RED at (4.5, 4.5) into blank(); no pixel equals scaled(RED, 0.5).
});
```
In `ball.test.ts`, add: `BALL_MODEL.tops` peaks at about `2 * BALL_RADIUS` in the middle column and is 0 in the grid's
corner column.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @zoom3d/web exec vitest run src/renderer/voxels.test.ts src/renderer/models/ball.test.ts`
Expected: FAIL (face count 8, no `tops`).

- [ ] **Step 3: Implement** the bottom face, `DIR_BOTTOM`, the sixth direction in `directLight`, and `sizeX`/`sizeY`/
  `tops` in `buildModel`. `directionLight` in `voxels.ts` already sizes from `FACES.length`. Update the FACES doc
  comment ("the bottom never faces the eye-height camera" now says the mirror needs it). `recolourBall` needs no
  change (it loops over `faceCount`).

- [ ] **Step 4: Run the renderer tests**

Run: `pnpm --filter @zoom3d/web exec vitest run src/renderer`
Expected: PASS. Then `pnpm bench:sprites`: the sprite hash must be unchanged from `main`, since bottom faces are culled.
Note the µs/frame (face loops grew).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/renderer/voxels.ts apps/web/src/renderer/lighting.ts apps/web/src/renderer/voxels.test.ts apps/web/src/renderer/models/ball.test.ts
git commit -m "Give voxel models bottom faces and a top-down height field"
```

### Task 2: How much of a lamp the floor sees past an object

**Files:**
- Create: `apps/web/src/renderer/object-shadows.ts`
- Modify: `apps/web/src/renderer/lighting.ts` (export `seenShare`, `LAMP_RADIUS`; extract `floorLampLight`)
- Test: `apps/web/src/renderer/object-shadows.test.ts`

**Interfaces:**
- Consumes: `VoxelModel.tops/sizeX/sizeY/voxel/height` (Task 1), `VoxelInstance`, `Light`.
- Produces:
  - `lighting.ts`: `export function floorLampLight(l: Light, px: number, py: number): number`, the bake's
    `falloff(df, l.radius) * (l.z / df)` with `df = √(flat² + l.z²)`. `bakeFloorAndCeiling` calls it in place of its
    inline `kf` (before `* seen`). `export function seenShare(...)` and `export const LAMP_RADIUS` unchanged otherwise.
  - `object-shadows.ts`: `export function objectSeenShare(v: VoxelInstance, l: Light, px: number, py: number): number`
    (0..1, how much of lamp `l`'s disc the floor point (px, py) sees past object `v`).
  - `export function shadowReach(v: VoxelInstance, l: Light): number`: the farthest a shadow point lies from the
    object's centre, in tiles: `r + (d + r) * h / (l.z − h)`, with `r` the footprint's half-diagonal
    (`√(sizeX² + sizeY²) · voxel / 2`), `d` the horizontal lamp-to-object distance and `h` the model's height,
    capped at `l.radius + r`.

- [ ] **Step 1: Write the failing tests** in `object-shadows.test.ts` (lamp `{ x: 5, y: 5, z: 0.85, radius: 4.5,
  r: 1, g: 1, b: 1 }`, a 0.4-tall test block of 8×8×8 voxels of 0.05 at (6, 5), angle 0)
  - `'a point on the lamp’s side sees all of it'`: (5.5, 5) → 1.
  - `'a point just behind the object sees none of it'`: (6.3, 5) → 0.
  - `'a point beyond the shadow’s tip sees all of it'`: (6 + shadowReach + 0.1, 5) → 1.
  - `'the shadow points away from the lamp'`: with the lamp moved to (7, 5), (6.3, 5) → 1 and (5.7, 5) → 0.
  - `'the penumbra is monotonic'`: sampling x from 6.2 to the tip in steps of 0.02 along y = 5 + 0.2 (the shadow's
    side edge), never increasing then decreasing; and some values strictly between 0 and 1.
  - `'the tip is soft too'`: at y = 5, some value strictly between 0 and 1 near the tip.
  - `'turning the object turns its shadow'`: a 0.1 × 0.5 tall slab; at angle 0 vs π/2 the share at a fixed point
    behind it differs.
  - `'an object right under the lamp shades the floor round it'`: object at (5, 5); (5.25, 5) → < 1, and no result is
    NaN.
  - `floorLampLight` equals the bake: for a one-lamp `bakeLighting` with ambient 0, `tint(FLOOR, kf)` of a cell
    matches `lm.floor` there.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @zoom3d/web exec vitest run src/renderer/object-shadows.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `objectSeenShare`**

Samples: a fixed set of points on the unit disc scaled by `LAMP_RADIUS`, made once at module load (start with 13: the
centre, 4 at half radius, 8 on the rim; the count may change if Task 3's perf or a visible grain asks for it). For each
sample S = (l.x + u, l.y + v, l.z), the segment from P = (px, py, 0) is blocked when it passes under a column's top:
```
move P and S into model space: subtract (v.x, v.y), rotate by −v.angle, add the grid's half extent so columns
start at 0; column size = voxel
only t ∈ [0, tMax] can be under the model, tMax = height / l.z (z rises linearly along the segment: z = l.z · t)
walk the xy grid cells the segment crosses for t in [0, tMax] (2D DDA, Amanatides–Woo), entering each at t_in
  if the cell is inside the grid and l.z · t_in < tops[cell]: blocked
share = unblocked samples / sample count
```
Early out before sampling: if P is farther than `shadowReach` from the object's centre, or not on the far side
(`(P − object) · (object − lamp) < −r`), return 1. No allocations.

Refactor `bakeFloorAndCeiling` to call `floorLampLight`. Run `pnpm bench:walls` before and after: the lighting hash
and pixel hash must be identical.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @zoom3d/web exec vitest run src/renderer/object-shadows.test.ts src/renderer/lighting.test.ts`
Expected: PASS; `pnpm bench:walls` hashes unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/renderer/object-shadows.ts apps/web/src/renderer/object-shadows.test.ts apps/web/src/renderer/lighting.ts
git commit -m "Work out how much of a lamp the floor sees past a voxel object"
```

### Task 3: Shadows in the floor tables, and the round shadow gone

**Files:**
- Modify: `apps/web/src/renderer/walls.ts` (`Room`, `LitRoom`, `glowTables` → frame tables, `floorAndCeilingColours`,
  `addRowReflection`)
- Modify: `apps/web/src/renderer/object-shadows.ts` (add `shadeFloor`)
- Modify: `apps/web/src/renderer/sprites.ts` (remove `drawVoxelShadows`), `apps/web/src/renderer/voxels.ts` (remove
  `shadowRadius`)
- Modify: `apps/web/bench/sprites.ts` (`drawWalls` sets `room.objects = s.voxels`), `apps/web/bench/walls.ts` (no
  objects: its hash must not change)
- Test: `apps/web/src/renderer/walls.test.ts`, `voxels.test.ts`, `models/ball.test.ts`, `sprites.test.ts`

**Interfaces:**
- Consumes: `objectSeenShare`, `shadowReach`, `floorLampLight`, `seenShare` (Task 2).
- Produces:
  - `Room` gains `objects?: readonly VoxelInstance[]` (left out: none). `RoomScene` and the landing room already carry
    `objects`, so `frame.ts` and `landing-scene.ts` need no change.
  - `interface FloorTables { floor: Uint32Array; ceiling: Uint32Array; floorLampSeen: Uint8Array }` in `walls.ts`;
    `floorAndCeilingColours(room)` returns it (a `Lighting` satisfies it when nothing patches).
  - `object-shadows.ts`: `export function shadeFloor(lm: Lighting, objects: readonly VoxelInstance[], albedo: number,
    tables: PatchedFloor, inView: (x: number, y: number, reach: number) => boolean): void`, where
    `PatchedFloor` is the frame tables' shape: `{ floor, floorLampSeen, touch(i: number): void }`. `touch` marks a cell
    dirty (zeroing its glow light) the first time each frame.

- [ ] **Step 1: Write the failing tests** in `walls.test.ts`, new `describe('renderWalls voxel shadows')`, with a
  corridor `'11111111111111\n1S...........1\n1............1\n1............1\n11111111111111'`, one lamp at
  (6.5, 2.5, 0.85, radius 4.5), ambient 0.3, `FLOOR`/`CEILING`, and `BALL_MODEL` instances:
  - `'a ball darkens the floor behind it from the lamp, not in front'`: eye (1.5, 2.5, angle 0); ball at (8.5, 2.5).
    Frame with `objects: [ball]` vs without: some floor pixels darker, none brighter; every darker pixel's floor point
    has x > 8.3 (project rows back with `PROJ`, as 'floor reflections in shadow' does).
  - `'shadows block the floor’s lamp reflection there'`: reflections `'both'`, ball at (8.5, 2.5): a floor pixel that
    shines without the ball and lies in its full shadow equals the matte (`floorLamp` emptied) frame's pixel there.
  - `'two balls never darken the floor below the lamp-less floor'`: balls at (8.5, 2.3) and (8.5, 2.7); every floor
    pixel ≥ the ambient-only floor colour, per channel.
  - `'the avatar glow still shows in a shadow'`: ball at (8.5, 2.5), a glow at (9.2, 2.5): the shadow's pixels with
    the glow are brighter than without it.
  - `'the floor is put back when the ball moves away'`: draw with the ball at (8.5, 2.5), then with it at (12.5, 1.5),
    out of the lamp's reach: the second frame equals one drawn with no objects (`firstDifference === −1`).
  - `'a ball behind the eye still casts its shadow ahead'`: eye (7.0, 2.5, angle 0), ball at (6.8, 2.5) behind the
    camera plane, lamp at (6.5, 2.5): floor ahead of the eye is darker than without the ball.
  - `'no shadow on a wall'`: ball at (12.6, 2.5) against the end wall: wall pixels (rows within `zbuffer`'s wall
    span) are identical with and without it.
  - `'no shadow unlit, in reflections-only mode, or out of every lamp’s reach'`: three frames that each equal their
    no-object twin.
  - `'moving a little changes the floor a little'`: ball stepped 0.02 tiles at a time from x 10.0 to 11.5 (across the
    lamp's reach edge at 11.0): between consecutive frames no floor pixel channel changes by more than 6.
- Delete the `shadowRadius` assertions in `voxels.test.ts` and `ball.test.ts`. In `sprites.test.ts`, any test that
  expects the vacuum's round shadow is rewritten to expect no darkening under the vacuum from `renderSprites`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @zoom3d/web exec vitest run src/renderer/walls.test.ts -t "voxel shadows"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`walls.ts`: rename `glowTables` to `frameTables`, add `floorLampSeen: Uint8Array` (a copy of the Lighting's, put back
per dirty cell with the floor and ceiling) and a `touch(i)` that marks dirty and zeroes `light[i*3..+3]`. Each lit
frame with objects or glows: put back last frame's dirty cells, run `shadeFloor` (when lamps light the room and there
are objects), then the glow pass, which now folds with `withGlow(t.floor[i], …)` (the shadowed value) rather than
`lm.floor[i]`. A frame with neither returns the Lighting itself, as today. `addRowReflection` reads
`tables.floorLampSeen` for the floor and `lm.floorLampSeen` for the ceiling. Pass `FLOOR` as `albedo` and
`outOfView`'s negation as `inView`.

`shadeFloor`, per lamp that has an object within `l.radius` horizontally:
```
for each such object: the cell box covering the circle of radius r at the object and the circle of radius
  r · l.z / (l.z − h) at the shadow's tip (object + unit(object − lamp) · (shadowReach − r)); skip the box if
  !inView(its centre, its half-diagonal)
for each floor cell (tileAt == 0) in the union of those boxes:
  objectSeen = product over the lamp's objects of objectSeenShare(v, l, cell centre)
  if objectSeen == 1: continue
  bakedSeen = this lamp's floorLampSeen slot / 255, or seenShare(map, x, y, l) when it isn't in the cell's list
  loss = floorLampLight(l, x, y) · bakedSeen · (1 − objectSeen) · OBJECT_SHADOW_DARKNESS (start at 1)
  touch(cell); floor[cell] −= albedo channel × l.r|g|b × loss, per channel, floored at 0
  scale this lamp's floorLampSeen slot by objectSeen (if listed)
```
Skip a cell early when `floorLampLight · bakedSeen` makes less than half a level of change (×255 on the brightest
channel). Iterating the union means looping each box and skipping cells already done for this lamp: a per-lamp stamp
array (Uint32 frame counter per cell, allocated once with the tables) avoids double work.

`sprites.ts`: delete `drawVoxelShadows` and its call; `voxels.ts`: delete `shadowRadius`.

- [ ] **Step 4: Run all checks**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. Run `pnpm bench:walls`: hashes unchanged (no objects). Run `pnpm bench:sprites`: note the walls-pass
cost with objects; target ≤ 0.3 ms over `main` at 640×360. If over, reduce the disc samples first.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/renderer apps/web/bench
git commit -m "Cast voxel objects' shadows from each lamp onto the floor"
```

### Task 4: The floor mirror

**Files:**
- Create: `apps/web/src/renderer/mirror.ts`
- Modify: `apps/web/src/renderer/voxels.ts` (`renderVoxelMirror`; `projectFaces` takes a side)
- Modify: `apps/web/src/renderer/walls.ts` (`drawLitRoom` calls the mirror pass)
- Test: `apps/web/src/renderer/mirror.test.ts`, `apps/web/src/renderer/walls.test.ts`

**Interfaces:**
- Consumes: Task 1's bottom faces; `Room.objects` (Task 3).
- Produces:
  - `mirror.ts`: `export interface MirrorBuffer` with `fit(width: number, height: number): void` (grow-only),
    `clear(box: ScreenBox): void`, `plot(x: number, y: number, colour: number): void` (coverage 1),
    `blur(box: ScreenBox, radiusPx: number): void` (separable box blur of premultiplied r, g, b and coverage),
    `blendInto(fb: Framebuffer, box: ScreenBox, strength: number, floorFrom: Int32Array): void` (only rows
    `≥ floorFrom[col]`: `p = p · (1 − s·a) + s · rgb`), `coverageAt(x: number, y: number): number`. `export function createMirrorBuffer(): MirrorBuffer`.
    `export interface ScreenBox { left: number; top: number; right: number; bottom: number }` (pixels, inclusive-
    exclusive).
  - `voxels.ts`: `export function renderVoxelMirror(fb: Framebuffer, view: View, v: VoxelInstance, lighting: Lighting,
    mirror: MirrorBuffer, floorFrom: Int32Array, blurTiles = MIRROR_BLUR): void`. With `blurTiles` 0 it skips the
    blur and the blend, leaving the coverage in `mirror` (for the holes test). `projectFaces(view, v, side: 'upright' | 'mirrored')`:
    mirrored negates every corner's z and the normal's z; the turned-away test uses the mirrored values.
  - Constants in `voxels.ts`: `MIRROR_STRENGTH = 0.1` (the floor's f0), `MIRROR_BLUR = 0.06` (tiles; pixels are
    `max(1, round(proj · MIRROR_BLUR / depth))`).

- [ ] **Step 1: Write the failing tests**

`mirror.test.ts`:
- `'blur keeps the total coverage'`: plot a 3×3 block, blur radius 2: the coverage sums to 9 (±1e-6) and spreads to
  pixels 2 beyond the block.
- `'blends only on floor rows'`: a box straddling `floorFrom`: rows above stay untouched.
- `'strength 0 leaves the frame alone'`.
`walls.test.ts`, `describe('renderWalls voxel mirror')` (Task 3's corridor and lamp, ball at (5.5, 2.5), eye
(1.5, 2.5, 0)):
- `'the ball shows in the floor below it'`: with vs without the ball, reflections `'both'`: pixels change only below the
  horizon, and some change in the columns the ball covers, in rows below the ball's floor contact row.
- `'no mirror with reflections none or walls, or unlit'`: those frames equal their no-object twins (Task 3's
  shadows aside: use a lamp-less map, `lighting` baked with no lamps, so only the mirror could differ).
- `'a ball behind a wall shows no mirror'`: a map with a pillar between the eye and the ball: frames match.
- `'the ball’s underside shows: no holes'` (in `voxels.test.ts`): `renderVoxelMirror(…, blurTiles 0)` on a lamp-less
  lighting into a fresh `MirrorBuffer`, eye 1.5 tiles away: every pixel inside the mirrored ball's outline (rows
  between its topmost and bottommost covered pixel, columns between the row's first and last) has coverage 1. Expose a
  `coverageAt(x, y): number` on `MirrorBuffer` for this.
- `'a far ball’s mirror fades out'`: ball at 8.5 tiles from the eye: no change.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @zoom3d/web exec vitest run src/renderer/mirror.test.ts src/renderer/walls.test.ts -t mirror`
Expected: FAIL.

- [ ] **Step 3: Implement**

`renderVoxelMirror`: skip when the eye's horizontal distance to `v` ≥ `REFLECTION_RANGE`. Light the instance
(`lightDirections`), project mirrored, work out the faces' screen box grown by the blur radius and clipped to the frame,
`clear` it, fill each face (far to near, depth-tested against `fb.zbuffer` like `fillFace`) with `plot` instead of
writing pixels, `blur`, then `blendInto` with `MIRROR_STRENGTH · (1 − (d / REFLECTION_RANGE)²)`. Write the fill as a
second function beside `fillFace`, not a flag inside it: `fillFace` is a measured hot loop.

`walls.ts`: one module-level `MirrorBuffer`; in `drawLitRoom`, after the floor reflections, when
`reflectsOnFloor(room.reflections)`, draw each object's mirror, far to near, passing `wallEnd` as `floorFrom`.

- [ ] **Step 4: Run all checks**

Run: `pnpm test && pnpm typecheck && pnpm lint`; `pnpm bench:walls` (hashes unchanged, no objects);
`pnpm bench:sprites` (note the cost; mirror plus shadows ≤ 0.4 ms over `main`).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/renderer
git commit -m "Mirror voxel objects in the shiny floor, blurred and faint"
```

### Task 5: Docs, numbers, and a look in the game

**Files:**
- Modify: `docs/open-decisions.md` (D24: a "Voxel shadows and floor mirror" bullet with date, the choices, the
  measured cost), `AGENTS.md` (world objects → Drawing: shadows and mirror run in `renderWalls`), the ball spec's
  "Banded floor shadow" line and the vacuum spec's §6.4 (pointers to the new spec), the new spec's Status line
  ("approved design, implemented 2026-10-23").

- [ ] **Step 1: Write the docs** with the bench numbers from Tasks 3 and 4.
- [ ] **Step 2: Check them**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Play it.** `pnpm dev`, open a room, walk to the ball and vacuum under corridor lamps. Screenshot
  shadows and the mirror for the product owner, who tunes `OBJECT_SHADOW_DARKNESS`, `MIRROR_STRENGTH` and `MIRROR_BLUR`
  by eye.

- [ ] **Step 4: Commit**

```bash
git add docs AGENTS.md
git commit -m "Record voxel shadows and the floor mirror"
```
