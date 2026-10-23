# Floor mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The floor mirrors walls, people and voxel objects alike: one frame layer, one blur, one fade, one strength.

**Architecture:** `mirror.ts` becomes one frame-sized layer that images are plotted into at full resolution (nearer
plots overwrite farther ones), then downsampled to half resolution and box-blurred with a radius per row. `walls.ts`
copies each wall column flipped under its foot into it, `sprites.ts` plots each person's disc upside down, `voxels.ts`
plots each object as now but no longer blurs on its own. The floor reflections read the layer's hiding coverage, then
its colour is added.

**Tech Stack:** TypeScript, vitest, Biome; `pnpm bench:walls`, `pnpm bench:sprites`.

**Spec:** `docs/superpowers/specs/2026-10-23-floor-mirror-design.md`

## Global Constraints

- No allocations per frame; scratch grows only when the frame does.
- One treatment: blur `MIRROR_BLUR` 0.06 tiles turned into pixels per row as `proj · MIRROR_BLUR / rowDistanceTiles`,
  fade `1 − (rowDistanceTiles / REFLECTION_RANGE)²` (0 past it), colour added at `MIRROR_STRENGTH` 0.3.
- Walls' images show but never hide lamp streaks; people's and objects' images show and hide.
- Mirror only in reflection modes `both` and `only`; not `none`, `walls` or unlit. Floor rows only.
- Not mirrored: held drinks, boomboxes, labels, shadows. Discs mirror unlit, as drawn.
- Code style per AGENTS.md / docs/code-style.md; compare frames with `firstDifference`.
- Perf target: whole mirror ≤ 0.4 ms at 640×360; over it, in order: nearest read-back (start there anyway), quarter-res
  blur, walls' image only within `REFLECTION_RANGE` (already implied by the fade), then report.

## Review Focus

1. A wall that fills the screen's height (standing against it): no floor, no image, no out-of-range reads (Task 2).
2. A person or object straddling the frame's edge or behind the eye: plotted only where on screen, never wrapping
   rows (Task 3).
3. Frame size or FOV change mid-session (phone rotation): layer, half-res buffers and per-row tables refit (Task 1).
4. A far image beyond `REFLECTION_RANGE` rows: nothing added, nothing hidden (Task 3, the rewritten far-ball test).
5. Reflections `only` mode: images drawn on the black floor, walls included (Task 2).

---

### Task 1: The layer: plot, two coverages, row-scaled half-resolution blur

**Files:**
- Rewrite: `apps/web/src/renderer/mirror.ts` (drop `MirrorBuffer`; new `MirrorLayer`)
- Test: `apps/web/src/renderer/mirror.test.ts` (rewritten)

**Interfaces:**
- Produces, in `mirror.ts`:
  - `export type MirrorKind = 'shows' | 'hides'` (`'hides'` also shows).
  - `export interface MirrorLayer {`
    - `fit(width: number, height: number): void` — grow-only; refits on any size change.
    - `clear(): void` — empties every row plotted since the last clear (track a dirty row range).
    - `plot(x: number, y: number, colour: number, kind: MirrorKind): void` — overwrites (callers plot far to near).
    - `shownAt(x: number, y: number): boolean` — full-res, before blur (for tests).
    - `blur(radiusPx: Float64Array): void` — downsample the dirty rows 2×2 into a half-res buffer of r, g, b
      (premultiplied), shown, hiding; then a separable box blur where full-res row `y`'s radius is `radiusPx[y]`
      (half-res radius `round(radiusPx[y] / 2)`). Horizontal pass: running sum per row. Vertical pass: a prefix sum per
      column, window `[y − r, y + r]` per row, so the radius may differ by row. Edges count as empty.
    - `coverageAt(x: number, y: number): number`, `hidingAt(x: number, y: number): number` — blurred, nearest half-res
      texel.
    - `readonly rows: { top: number; bottom: number }` — the blurred rows, `[top, bottom)`; empty when equal.
    - `addInto(fb: Framebuffer, strength: number, weight: Float64Array, floorFrom: Int32Array): void` — on rows from
      `floorFrom[x]` down: `p += strength · weight[y] · rgb` (premultiplied), clamped.
  - `}` and `export function createMirrorLayer(): MirrorLayer`.

- [ ] **Step 1: Write the failing tests** (`mirror.test.ts`, a 40 × 40 layer, `radius = new Float64Array(40)`):
  - `'a nearer plot covers a farther one'`: plot RED then BLUE at (20, 20) → after `blur(radius)` with radius 0,
    `coverageAt` 1 and `addInto` with strength 1, weight 1 gives the BLUE channel's value.
  - `'shows and hides are kept apart'`: a 4 × 4 'shows' block and a 4 × 4 'hides' block side by side; radius 0:
    `coverageAt` is 1 on both, `hidingAt` 1 only on the second.
  - `'the blur keeps a row’s coverage and is wider where the row’s radius is'`: an 8-px-wide 'shows' bar on rows
    10–30; `radius[y] = y < 20 ? 2 : 8`: summed `coverageAt` across row 15 and row 25 equal (±2% of 8), and the bar
    reaches 4 px farther out on row 25 than on row 15.
  - `'clear empties what was plotted'`: plot, clear, blur → `coverageAt` 0 and `rows` empty.
  - `'adds on floor rows only, times each row’s weight'`: RED 'shows' over every row of a GREY frame, `floorFrom` 20,
    `weight[y] = 0.5`, radius 0, strength 1: row 19 stays GREY, row 30 gains half of RED.
  - `'refits to a new frame size'`: `fit(40, 40)`, plot, `fit(60, 30)`, clear, blur: no throw, coverage 0.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/mirror.test.ts` → FAIL (`createMirrorLayer` has no `plot`).
- [ ] **Step 3: Implement** `mirror.ts` as above. Full-res store: `Uint32Array` colour + `Uint8Array` kind (0 none,
  1 shows, 2 hides). Half-res: `Float32Array` × 5 channels, plus a column prefix scratch of `(height/2 + 1) × 5`.
- [ ] **Step 4: Run** the same → PASS. `voxels.ts`/`walls.ts` won't compile yet against the new API; Task 3 rewires
  them. Keep this task's commit compiling by leaving the old `createMirrorBuffer` export in place until Task 3 deletes
  it.
- [ ] **Step 5: Commit** `git add apps/web/src/renderer/mirror.ts apps/web/src/renderer/mirror.test.ts && git commit -m "Give the floor mirror one layer with a blur that widens towards the eye"`

### Task 2: The walls' image

**Files:**
- Modify: `apps/web/src/renderer/walls.ts` (`drawLitRoom`, new `mirrorWalls`, per-row `mirrorBlurPx` and
  `mirrorWeight` in `fitScratchToFrame`)
- Test: `apps/web/src/renderer/walls.test.ts`

**Interfaces:**
- Consumes: `MirrorLayer` (Task 1).
- Produces: in `walls.ts`, module tables `mirrorBlurPx: Float64Array` and `mirrorWeight: Float64Array` per row (0 on
  ceiling rows and past `REFLECTION_RANGE`), filled in `fitScratchToFrame`; `function mirrorWalls(fb: Framebuffer): void`
  plotting, for each column, rows `y` from `wallEnd[col]` while `k = y − wallEnd < wallEnd − wallStart` and
  `mirrorWeight[y] > 0`, the colour `pixels[(wallEnd − 1 − k) · w + col]` as `'shows'`.
- `drawLitRoom` order with floor reflections on: floor → `mirrorLayer.fit` + `clear` → `mirrorWalls` → people and
  objects (Task 3) → `mirrorLayer.blur(mirrorBlurPx)` → floor reflections (hiding by `hidingAt · mirrorWeight[y]`) →
  `mirrorLayer.addInto(fb, MIRROR_STRENGTH, mirrorWeight, wallEnd)`.

- [ ] **Step 1: Write the failing tests** (`describe('renderWalls floor mirror of walls')`, a lamp-less room
  `'1111111\n1.....1\n1..S..1\n1.....1\n1111111'` baked with no lamps, eye at (3.5, 2.5) facing east, wall 2.5 ahead):
  - `'the floor under a wall’s foot takes some of the wall’s colour'`: `both` vs `walls` mode: the pixel 2 rows below
    `wallEnd` of the middle column is brighter in `both`; rows past the image's end plus the blur radius are equal.
  - `'a wall’s image never hides a lamp’s streak'`: the existing `'renderWalls floor reflections'` hall with its lamp,
    `both` mode, shiny vs matte (`floorLamp` emptied): the streak added within the end wall's image rows is > 0.
  - `'standing against a wall leaves nothing to mirror'`: eye 0.3 from a wall, facing it: renders without throwing,
    and `both` equals `walls` mode frame (`firstDifference === −1`).
  - `'the reflections alone show the walls’ image on black'`: `only` mode, lamp-less room: some floor pixel under the
    wall isn't black.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/walls.test.ts -t "floor mirror of walls"` → FAIL.
- [ ] **Step 3: Implement** as in Interfaces (Task 3 adds people and objects between `mirrorWalls` and `blur`; until
  then call the existing object mirror path after `mirrorWalls`, adapted to plot into the layer — see Task 3, Step 3,
  which may be folded in here if simpler).
- [ ] **Step 4: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer` → the new tests PASS; existing mirror
  tests may fail until Task 3.
- [ ] **Step 5: Commit** `git commit -am "Mirror the walls in the floor"`

### Task 3: People and objects in the shared layer, floor-distance fade

**Files:**
- Modify: `apps/web/src/renderer/sprites.ts` (export `mirrorDisc`), `apps/web/src/renderer/voxels.ts`
  (`renderVoxelMirror` plots only), `apps/web/src/renderer/walls.ts` (`Room.people?`, far-to-near people and objects),
  `apps/web/src/renderer/frame.ts` (`RoomScene` keeps `people` from `PeopleAndObjects`), `apps/web/src/ui/landing-scene.ts`
  only if its room needs `people` passed (it already carries them)
- Test: `sprites.test.ts`, `voxels.test.ts`, `walls.test.ts`

**Interfaces:**
- Consumes: `MirrorLayer` (Task 1), `mirrorWalls` and the per-row tables (Task 2).
- Produces:
  - `sprites.ts`: `export function mirrorDisc(fb: Framebuffer, view: View, s: Sprite, layer: MirrorLayer): void` —
    projects like `projectSprite`; image centre row `half + proj · (EYE_HEIGHT + lift) / depth` with `lift` the bob's
    `BOB_HEIGHT · AVATAR_RADIUS · s.bob`; face rows read upside down; per column depth test against `fb.zbuffer`;
    `'hides'`; rows clipped to the frame.
  - `voxels.ts`: `renderVoxelMirror(fb: Framebuffer, view: View, v: VoxelInstance, lighting: Lighting, layer:
    MirrorLayer): void` — no distance cull beyond `depth < 0`, no blur; plots `'hides'`.
  - `walls.ts`: `Room` gains `people?: readonly Sprite[]`; people and objects are ordered together far to near (one
    reused index array, people then objects offset by `people.length`).
- [ ] **Step 1: Write the failing tests**
  - `sprites.test.ts` `'a person’s image is upside down under the disc'`: a face whose top half is RED and bottom half
    BLUE, person 3 tiles ahead, `mirrorDisc` into a fresh layer: every shown row is below the horizon (`> half`), the
    lowest shown row is RED and the highest BLUE.
  - `sprites.test.ts` `'a person off the frame’s edge plots only on screen'`: disc half past the right edge: no throw,
    shown pixels only at x < width.
  - `voxels.test.ts`: the holes test calls `renderVoxelMirror(fb, view, ball, lighting, layer)` and checks
    `layer.shownAt`.
  - `walls.test.ts`: rewrite `'a far ball’s mirror fades out'` on a 20-wide corridor, eye (1.5, 2.5), ball at 17.5:
    frames with and without the ball equal. Add `'a person shows in the floor'`: lamp-less corridor, person 3 ahead in
    `people`, `both` vs no person: floor pixels under the disc change, none above the horizon.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer` → the new tests FAIL.
- [ ] **Step 3: Implement**; delete `createMirrorBuffer`, `MIRROR_BLUR`'s per-object use and `fitMirrorBox`'s blur
  growth (the box isn't needed for plotting beyond clipping).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm lint` → PASS. Tests that compared frames with and without
  an object still hold (the walls' image is in both); fix any whose bounds assumed a per-object blur radius, ledgering
  each.
- [ ] **Step 5: Commit** `git add apps/web && git commit -m "Mirror people and objects in the same floor layer as the walls"`

### Task 4: Cost, docs and a look

- [ ] **Step 1:** `pnpm bench:walls` and `pnpm bench:sprites` (check `uptime` load < 4 first). Compare `both` with the
  previous run (1.115 ms `both` in bench:walls before). Over 0.4 ms for the mirror: apply the Global Constraints order.
- [ ] **Step 2:** Offline renders of LEVEL1 (scratchpad script as before) along a corridor and at the ball; look.
- [ ] **Step 3:** Docs: D24 bullet (walls and people in the floor, one layer, cost), AGENTS.md world objects →
  Drawing (people too), voxel spec §3.3 pointer, floor mirror spec status. `git add` only those paths (never
  `docs/spikes/`). Commit `"Record the floor mirror"`.
