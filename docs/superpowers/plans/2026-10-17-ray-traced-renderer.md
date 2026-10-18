# Ray-Traced Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second, switchable "Ray traced" lighting mode: walls, floor and ceiling lit by a ray-traced bake (soft
shadows, bounce light) with cone-traced reflections that show lamps and people, smooth on phones.

**Architecture:** A new module `apps/web/src/renderer/traced/` replaces `renderWalls` in `renderView` when the mode is
traced. It fills the same `Framebuffer` (`pixels`, `zbuffer`), so `renderSprites` and everything after it run
unchanged. Every ray is a 2D grid walk plus a height check. The bake runs a slice per frame; until it finishes the
current lit renderer draws.

**Tech Stack:** TypeScript, CPU software rendering into `ImageData`, vitest (+ happy-dom for UI), Playwright e2e,
esbuild benches. pnpm workspace; `@zoom3d/shared` for the map and `castRay`.

**Spec:** `docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md`. Reference prototype (throwaway, not a
source to port blindly): `spikes/raytrace/` (`trace.ts`, `bake.ts`, `render.ts`).

## Global Constraints

- Branch `feat/ray-traced-renderer` cut from `origin/main` (it already contains the current branch's work).
- Code style: Biome (`pnpm exec biome check --write .`), 120 columns, single quotes, semicolons, `es5` trailing
  commas, every `if`/`else`/`for`/`while` body braced; `docs/code-style.md` (names explain, comments say why, `.at()`
  for reads outside hot paths, no `arr[i] as T`); no "you/your" in identifiers, comments or test titles.
- Hot paths (per frame, per pixel): no allocation; buffers refit only when the frame's size or FOV changes.
- The current renderer is untouched: `pnpm bench:walls` output byte-identical before and after every task;
  `pnpm bench:sprites` pixel hash unchanged.
- Default Lighting mode stays `'reflections'`. The landing page keeps the current renderer. `?lights=off` draws the
  flat, unlit room in every mode.
- Pure rays: no base light, bounce at linear colour.
- Spec values, verbatim: lamp disc radius **0.18**, radiance **36**, tint **(1, 0.84^2.2, 0.6^2.2)**; lamp light
  `radiance × r² × cos(surface) × cos(disc) / d²` faded by `(1 − (flat/8)^4)²` to nothing at **8** tiles; shadow rays
  to centre and edges, then **8** strips weighted by chord length; floor/ceiling light **8** per tile side
  (bilinear); walls **8** across × **3** heights (0, 0.5, 1); bounce **3** passes × **16** cosine rays; 3×3 average of
  open floor/ceiling bounce; soft copy = box ±**4** cells, twice; materials (f0 0.04 all): floor roughness **0.6** tint
  **0**, stone **0.85**/**0.6**, wood **0.35**/**0.75**, blue **0.85**/**0.85**; cone width roughness² per tile,
  stretch 1/slant (slant ≥ **0.1**); faces sharp below **0.3** radius of cone; texture fades to mean by **0.25** tiles
  of cone, light to soft copy by **1** tile; edge blend ≥ **0.02**; reflections at **½** resolution; rough walls
  (roughness² > **0.25**) traced every **4th** row; exposure **4**; tone `1 − e^−x` on the brightest channel, whitening
  from x **3** to **30** up to **0.75**; bake slice **6 ms** per frame.

## Review Focus

- `?lights=off` with "Ray traced" chosen: expect the flat, unlit room (Task 8 test).
- Switching modes while the bake is half done, then back: the bake resumes where it stopped, never restarts (Task 8).
- Portrait phone frames (e.g. 296×640, FOV 50°) and frame-size changes mid-room: no NaN or unwritten pixels (Task 7).
- Degenerate rays: facing exactly along a grid axis, the eye 0.26 tiles from a wall: no NaN, no gaps (Tasks 3, 7).
- A crowd (`?bots=100`): per-ray lists overflow gracefully, the nearest people still reflect, the frame holds (Task 10).

---

### Task 1: "Ray traced" in the Lighting setting

**Files:**
- Modify: `apps/web/src/ui/render-settings.ts`, `apps/web/src/ui/audio-panel.ts`
- Test: `apps/web/src/ui/render-settings.test.ts`

**Interfaces:**
- Produces: `RenderMode` gains `'traced'` (last in `RENDER_MODES`); `RENDER_MODE_NAMES: Record<RenderMode, string>`
  (moved from `audio-panel.ts`'s `MODE_NAMES`, adding `traced: 'Ray traced'`); `tracesRays(mode: RenderMode): boolean`;
  `litReflections('traced') === 'both'` (what draws while the bake runs).

- [ ] **Step 0: Branch, and commit the spec, this plan and the spike as reference**

```bash
git fetch origin && git switch -c feat/ray-traced-renderer origin/main
git add docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md docs/superpowers/plans/2026-10-17-ray-traced-renderer.md spikes/raytrace/*.ts spikes/raytrace/*.mjs spikes/raytrace/*.html spikes/raytrace/*.md spikes/raytrace/tsconfig.json
git commit -m "Add the ray-traced renderer's design, plan and spike"
```

(`dist/` is gitignored; Biome ignores `spikes/`.)

- [ ] **Step 1: Write the failing tests** in `render-settings.test.ts`: the existing list test becomes
  `expect(RENDER_MODES).toEqual(['flat', 'shadows', 'reflections', 'reflections-only', 'traced'])`; the mapping test
  becomes `[null, 'none', 'both', 'only', 'both']`; new `test('only the traced mode traces rays')`:
  `RENDER_MODES.filter(tracesRays)` equals `['traced']`; `RENDER_MODE_NAMES.traced === 'Ray traced'`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/ui/render-settings.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** in `render-settings.ts`; `audio-panel.ts` imports `RENDER_MODE_NAMES` instead of its own
  record. Update the `RenderMode` doc comment: traced draws with rays once baked, the lit room until then.
- [ ] **Step 4: Run** `pnpm vitest run apps/web/src/ui` and `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `git commit -am "Add a Ray traced lighting mode (draws the lit room for now)"`

### Task 2: A Lighting button in the touch tray

**Files:**
- Modify: `apps/web/src/ui/icons.ts`, `apps/web/src/ui/touch-controls.ts`, `apps/web/src/ui/render-settings.ts`,
  `apps/web/src/game/room-controls.ts`, `apps/web/src/game/game.ts`
- Test: `apps/web/src/ui/touch-controls.test.ts`, `apps/web/src/ui/render-settings.test.ts`, `apps/web/e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: `RENDER_MODES`, `RENDER_MODE_NAMES` (Task 1).
- Produces: `nextRenderMode(mode: RenderMode): RenderMode` (the next in `RENDER_MODES`, wrapping); `TouchControlsState`
  gains `lighting: RenderMode`; `TouchControlsOptions` gains `onLighting(): void`; `RoomControlsOptions` gains
  `renderMode(): RenderMode` and `setRenderMode(mode: RenderMode): void`; `touchIcon('lighting')` (a bulb).

- [ ] **Step 1: Write the failing tests.**
  - `render-settings.test.ts`: `nextRenderMode('flat') === 'shadows'`, `nextRenderMode('traced') === 'flat'`.
  - `touch-controls.test.ts` (`options()` gains `lighting: 'reflections'`, `onLighting: vi.fn()`):
    `test('the Lighting button steps the mode, keeps the tray open and names the mode')` — open ⋯, click
    `[data-action="lighting"]`: `onLighting` called once, `tray().hidden === false`; its text contains
    `'Shadows and reflections'`; after `controls.update({ held: null, boombox: false, map: false, lighting: 'traced' })`
    it contains `'Ray traced'`.
  - `mobile.spec.ts`: `test('the tray steps the lighting to Ray traced, and it is kept')` — phone joins, opens ⋯, clicks
    the Lighting button until its text is `Ray traced` (at most 5 clicks; the tray stays open), then
    `localStorage['zoom3d.render.v1']` parses to `{ mode: 'traced' }`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/ui` — expect FAIL.
- [ ] **Step 3: Implement.** The Lighting button is added after Map with `data-action="lighting"`, the bulb icon and a
  label span showing `RENDER_MODE_NAMES[s.lighting]`; unlike the other choices it does **not** close the tray (stepping
  through modes takes several taps). `room-controls.ts` passes `lighting: o.renderMode()` in `refresh()` and
  `onLighting: () => { o.setRenderMode(nextRenderMode(o.renderMode())); refresh(); }`. `game.ts` gets one
  `setRenderMode(mode)` that sets `renderSettings`, saves it (`saveRenderSettings`) and is used by both the console's
  `onChange` and the tray.
- [ ] **Step 4: Run** `pnpm vitest run apps/web/src/ui`, `pnpm typecheck`, then
  `pnpm --filter @zoom3d/web exec playwright test e2e/mobile.spec.ts -g "lighting"` — expect PASS.
- [ ] **Step 5: Commit** `git commit -am "Step the lighting mode from the touch tray"`

### Task 3: The traced world and the ray walk

**Files:**
- Create: `apps/web/src/renderer/traced/world.ts`, `apps/web/src/renderer/traced/ray.ts`
- Test: `apps/web/src/renderer/traced/world.test.ts`, `apps/web/src/renderer/traced/ray.test.ts`

**Interfaces:**
- Produces (`world.ts`):
  - `TracedMaterial { f0: number; roughness: number; tint: number }`, `TRACED_MATERIALS` by tile id (0 = floor), the
    spec's table.
  - `LAMP_RADIUS = 0.18`, `LAMP_RADIANCE = 36`.
  - Face sides `FACE_WEST = 0, FACE_EAST = 1, FACE_NORTH = 2, FACE_SOUTH = 3` (the side a ray enters a wall cell
    through), `FACE_NORMAL_X`, `FACE_NORMAL_Y` (pointing into the open cell).
  - `TracedWorld { map; width; height; faceIndex: Int32Array /* cell×4+side, −1 when no floor in front */; faceCount;
    lampX, lampY: Float64Array; lampAt: Int16Array /* per tile */; lampRgb: Float32Array /* radiance × tint */;
    albedo: readonly Float32Array[] /* linear rgb per texel, by tile id */; meanAlbedo: readonly Float32Array[];
    gloss: readonly Uint8Array[]; floorAlbedo, ceilingAlbedo: Float32Array }`.
  - `buildTracedWorld(map: GameMap, textures: readonly Uint32Array[], lamps: readonly { x: number; y: number }[]): TracedWorld`
    (albedo from `textures` via sRGB→linear; `gloss` = `GLOSS`; floor/ceiling from `FLOOR`, `CEILING` in `walls.ts`).
  - `isWall(world, x: number, y: number): boolean` (tile coords; off the map is wall), `lampOver(world, x, y): number`
    (lamp index or −1, ceiling point in tiles).
- Produces (`ray.ts`): `Ray3 { x, y, z, dx, dy, dz }`; `HIT_NONE = 0, HIT_WALL = 1, HIT_FLOOR = 2, HIT_CEILING = 3`;
  `RayHit3 { kind; t; x; y; z; tile; side; faceIndex; u }` (`t` in units of the direction vector; `u` 0..1 along the
  face: y for west/east faces, x for north/south); `createRay3()`, `createRayHit3()`;
  `trace(world, ray: Ray3, maxT: number, out: RayHit3): RayHit3`;
  `clearBetween(world, ax, ay, bx, by): boolean` (2D shadow ray; walls are full height).

- [ ] **Step 1: Write the failing tests** on small `parseMap` maps:
  - `trace` east from (1.5, 1.5, 0.5) in a 6×3 corridor walled at x = 5: `kind HIT_WALL`, `t ≈ 3.5`, `side FACE_WEST`,
    `faceIndex ≥ 0`, `u ≈ 0.5`.
  - straight down (`dz = −1`, no horizontal motion) → `HIT_FLOOR` at `z = 0`, `t = 0.5`; up → `HIT_CEILING`.
  - rising at slope 1 toward a wall 3 tiles away → `HIT_CEILING` before the wall.
  - exactly axis-aligned rays (`dy = 0`, then `dx = 0`) return finite `t` (no NaN).
  - `maxT` shorter than the wall → `HIT_NONE`.
  - `clearBetween` across open floor → true; across a wall cell → false.
  - `buildTracedWorld`: a wall face with a wall in front has `faceIndex −1`; `lampOver` is the lamp at its centre and
    −1 at 0.19 tiles away; `lampRgb[0] === 36`, `lampRgb[2] ≈ 36 × 0.6 ** 2.2`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/renderer/traced` — expect FAIL.
- [ ] **Step 3: Implement** `trace` as a grid DDA bounded by `min(maxT, t at which z reaches 0 or 1)`; a zero direction
  component gets an infinite side distance (never `0 × ∞`). `clearBetween` is `trace` at z 0.5 with `dz = 0` and
  `maxT = 1 − 1e−9`. Reference: `spikes/raytrace/trace.ts`, `world.ts`.
- [ ] **Step 4: Run** the tests — expect PASS. **Step 5: Commit** "Add the traced world and its ray walk".

### Task 4: Lightmaps and direct light with soft shadows

**Files:**
- Create: `apps/web/src/renderer/traced/lightmaps.ts`, `apps/web/src/renderer/traced/bake.ts`
- Test: `apps/web/src/renderer/traced/bake.test.ts`, `apps/web/src/renderer/traced/lightmaps.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces (`lightmaps.ts`): `FLOOR_CELLS = 8` (per tile side), `WALL_COLUMNS = 8`, `WALL_HEIGHTS = 3`,
  `wallSampleHeight(row: number): number` (0, 0.5, 1); `TracedLightmaps { floor; ceiling; wall; floorSoft;
  ceilingSoft; floorBounce: Float32Array }` (linear rgb irradiance, interleaved; floor/ceiling row-major
  `(width·8) × (height·8)`; wall `((faceIndex·3 + row)·8 + column)·3`); `createLightmaps(world): TracedLightmaps`;
  `planeLight(lm: Float32Array, world, x, y, out: Float32Array): void` (bilinear at a point in tiles);
  `wallColumnLight(maps, faceIndex: number, u: number, out: Float32Array): void` (the face's light at `u`, linear across
  its 8 columns, at each of the 3 heights → `out[row·3 + c]`; `faceIndex −1` gives zeros).
- Produces (`bake.ts`): `SurfacePoint { x, y, z, nx, ny, nz }`; `lampLight(world, at: SurfacePoint, out: Float32Array): void`
  (the spec's formula, summed over lamps, soft shadows by strips); `bakeLighting(world, maps): Generator<number, void, void>`
  yielding the fraction done (this task: the direct pass only, over every open floor cell, ceiling cell and wall
  sample; wall samples sit 1e−3 in front of their face).

- [ ] **Step 1: Write the failing tests** (open 9×9 room, one lamp at its centre):
  - floor under the lamp: `out[0] ≈ 36 × 0.18² = 1.1664` (±1%), `out[1] ≈ out[0] × 0.84 ** 2.2`, `out[2] ≈ out[0] × 0.6 ** 2.2`.
  - a ceiling point gets 0; along a 3×14 corridor with the lamp at one end, a floor point 8.5 tiles away gets 0.
  - a floor point behind a wall pillar from the lamp gets 0.
  - across a doorway's shadow edge (sample a line of floor points), light never increases going into the shadow and at
    least one point lies strictly between 0 and the lit value (soft).
  - draining `bakeLighting` yields increasing fractions ending at 1, and the floor cell under the lamp equals
    `lampLight` at that cell's centre.
  - `planeLight` between two cells is their average; `wallColumnLight` at `u = 0.5` blends columns 3 and 4.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** `seenShare`: shadow rays to the disc's centre and to ±0.9 r across
  the 2D direction first; all clear → 1, all blocked → 0, otherwise 8 strips at offsets `((i + 0.5)/8·2 − 1)·r`
  weighted by `sqrt(1 − s²)` (normalised). Reference: `spikes/raytrace/bake.ts` `directLight`, `seenShare`.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** "Bake traced direct light with soft shadows".

### Task 5: Bounce light and the soft copies

**Files:**
- Modify: `apps/web/src/renderer/traced/bake.ts`
- Test: `apps/web/src/renderer/traced/bake.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces: `bakeLighting` now runs direct, then **3** bounce passes, then finishing (smoothing, filling wall cells,
  soft copies); `maps.floorBounce` holds the floor's bounce part alone (for the vacuum, Task 11). Uses `seeded()` from
  `@zoom3d/shared` so bakes are deterministic.

- [ ] **Step 1: Write the failing tests:**
  - the ceiling above a lit floor is 0 after the direct pass and > 0 after `bakeLighting` completes.
  - colour bleeding: in two identical rooms, one with blue-brick walls (tile 3) and one with stone (tile 1), the floor
    cell beside the lit wall has a higher blue/red ratio in the blue room.
  - two bakes of the same world produce identical arrays.
  - a floor cell inside a wall tile holds the mean of its open neighbours (no black at wall edges).
  - `floorSoft` of a map with one bright cell is smooth: non-increasing outwards along a row for 8 cells, sum within 5%
    of the sharp map's.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Each pass: per sample, 16 cosine-weighted rays (4×4 strata,
  jittered, one random rotation per sample), `trace` up to 12 tiles; a hit brings back (previous total light at the hit,
  nearest sample) × the hit surface's **linear** colour (`meanAlbedo[tile]`, `floorAlbedo`, `ceilingAlbedo`); a ceiling
  hit inside a lamp disc brings nothing; the result is the mean over rays. Pass n reads direct + pass n−1. After the
  last pass: 3×3 mean over open floor and ceiling bounce cells; total = direct + bounce; fill wall-tile cells from open
  8-neighbours (2 rounds); soft copies by a running-sum box of ±4 cells, rows then columns, twice. Reference:
  `spikes/raytrace/bake.ts` `gatherBounce`, `smoothFloor`, `spreadIntoWalls`, `soften`.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** "Bake traced bounce light".

### Task 6: Optics and tone

**Files:**
- Create: `apps/web/src/renderer/traced/optics.ts`, `apps/web/src/renderer/traced/tone.ts`
- Test: `apps/web/src/renderer/traced/optics.test.ts`, `apps/web/src/renderer/traced/tone.test.ts`

**Interfaces:**
- Produces: `fresnel(cos: number, m: TracedMaterial): number` (Schlick, held down by roughness, cos clamped to 0..1);
  `blobWeight(across: number, up: number, radius: number, spreadAcross: number, spreadUp: number): number` (0..1);
  `EXPOSURE = 4`; `shownPixel(r: number, g: number, b: number): number` (linear radiance → packed `0xffBBGGRR`).

- [ ] **Step 1: Write the failing tests:**
  - `fresnel(1, m) === m.f0`; `fresnel(0, m) === Math.max(1 − m.roughness, m.f0)`; non-increasing in `cos`.
  - `blobWeight(0, 0, 0.35, 0, 0) === 1`; decreases with `across` and with `up`; 0 once
    `across²/(2a²) + up²/(2u²) > 9`; for spreads ≥ radius, its numerical integral over a fine grid is within 5% of
    `π·r²`.
  - `shownPixel(0, 0, 0) === 0xff000000`; equal channels give equal bytes; `shownPixel(0.1, 0.05, 0)` has red > green
    > blue = 0 and is not white; the lamp's own radiance `(36, 36·0.84^2.2, 36·0.6^2.2)` gives red 255 and
    red ≥ green ≥ blue > 0 (regression: overflowing the tone table once turned lamps blue); `shownPixel(1e6, 1e6, 0)`
    is finite; brighter grey never gives a darker byte.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** `blobWeight`: `a² = r²/4 + spreadAcross²`,
  `u² = r²/4 + spreadUp²`, `f = across²/(2a²) + up²/(2u²)`, weight `min(1, r²/(2·sqrt(a²u²)))·e^−f`.
  `shownPixel`: x = EXPOSURE × brightest channel; scale = `(1 − e^−x)/x` (tabulated at 64 steps per unit up to 128,
  `1/x` beyond); whitening `0.75·smoothstep((x − 3)/27)` toward the toned brightest value; sRGB encode via a 4096-entry
  table.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** "Add the traced renderer's optics and tone curve".

### Task 7: The traced frame (no reflections yet)

**Files:**
- Create: `apps/web/src/renderer/traced/frame.ts` (public `renderTraced`), `apps/web/src/renderer/traced/buffers.ts`
  (per-frame-size buffers and the view), `apps/web/src/renderer/traced/primary.ts` (walls per column, floor and
  ceiling per row)
- Test: `apps/web/src/renderer/traced/frame.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6; `Framebuffer`, `setView`/`View` (`renderer/camera.ts`), `castRay` (`@zoom3d/shared`),
  `Sprite` (`renderer/sprites.ts`).
- Produces: `TracedLighting { world: TracedWorld; maps: TracedLightmaps }`;
  `TracedScene { map: GameMap; eye: PlayerState; people: readonly Sprite[]; traced: TracedLighting }`;
  `renderTraced(fb: Framebuffer, scene: TracedScene): void` — writes every pixel and `fb.zbuffer` (perpendicular
  distance per column, as `renderWalls`). Internally keeps a linear `hdr` buffer and a per-pixel Fresnel weight and
  tile id for Task 9. `TracedBuffers` and `lastTracedBuffers(): Readonly<TracedBuffers>` (the last frame's `spec`,
  `specTile`, and from Task 9 `reflected`, `reflectedWidth`, `reflectedHeight`), for tests and the bench only.

- [ ] **Step 1: Write the failing tests** (LEVEL1 baked once in `beforeAll`; poses near lamps):
  - `fb.zbuffer` equals `renderWalls`' for the same map and pose (same wall geometry).
  - a ceiling pixel inside a lamp disc: red 255, red ≥ green ≥ blue (warm white).
  - the floor pixel under a lamp is brighter than floor pixels 4 tiles further down the same corridor.
  - a floor pixel near the bottom of the frame has a lower Fresnel weight (`lastTracedBuffers().spec`) than one just
    below the horizon.
  - every pixel is written (alpha 0xff, no NaN-born zeros) at: angle exactly 0 and exactly π/2; the eye 0.26 tiles from
    a wall; a 296×640 frame with `FOV_TALL`; and after switching the same `fb` from 640×360 to 296×640.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Walls per column: `castRay` with the same column ray as
  `walls.ts` `castColumnRay` (`cameraX = 2·col/W − 1`, not the column's centre, or the zbuffer differs) and the same
  `start`/`end` rows; light per column from `wallColumnLight` once, then per row blended between the 3 heights
  at the pixel's z, times the texel's linear albedo. Floor and ceiling per row (rows, not columns: cache-friendly),
  points stepped evenly across the row, `planeLight` bilinear inlined, a ceiling point inside a lamp disc shows
  `lampRgb`. Composite with `shownPixel` (inline its table lookups in the loop). Floor Fresnel per pixel is precomputed
  per frame size (it depends only on screen position). Reference: `spikes/raytrace/render.ts` `drawColumn`,
  `drawFloorAndCeiling`.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** "Draw the traced room: walls, floor, ceiling and lamps".

### Task 8: The traced room in the game, a bench, and the first phone check

**Files:**
- Create: `apps/web/src/renderer/traced/room.ts`, `apps/web/bench/poses.ts`, `apps/web/bench/traced.ts`
- Modify: `apps/web/src/renderer/frame.ts`, `apps/web/src/game/room-loop.ts`, `apps/web/src/game/game.ts`,
  `apps/web/bench/walls.ts`, `package.json`, `AGENTS.md`, `docs/open-decisions.md`
- Test: `apps/web/src/renderer/traced/room.test.ts`

**Interfaces:**
- Consumes: Task 7, `tracesRays` (Task 1), `corridorLights`.
- Produces: `TracedRoom { bake(budgetMs: number): void; lighting(): TracedLighting | null }`;
  `createTracedRoom(map: GameMap, textures: readonly Uint32Array[], lit: boolean): TracedRoom` (builds the world and
  the generator on the first `bake`, steps it until the budget is spent, `lighting()` non-null once done; `lit: false`
  never bakes and stays null); `RoomScene` gains `traced: TracedLighting | null`; `RoomLoopOptions` gains
  `tracedRoom: TracedRoom`; `BAKE_SLICE_MS = 6`.

- [ ] **Step 1: Write the failing tests** (`room.test.ts`, on a small map): repeated `bake(1)` calls end with
  `lighting()` non-null and maps equal to one long `bake(Infinity)`; no `bake` call → null; after some slices, a pause
  (no calls) then more slices finish with the same maps (switching modes mid-bake resumes, never restarts);
  `lit: false` → null after `bake(Infinity)`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** `room-loop.ts` `describeScene`: when `tracesRays(mode)`, call
  `o.tracedRoom.bake(BAKE_SLICE_MS)` and set `scene.traced = o.tracedRoom.lighting()`; otherwise `scene.traced = null`.
  The lit fallback (`litReflections('traced') === 'both'`) keeps drawing until it is ready. `frame.ts` `drawRoom`:
  `scene.traced ? renderTraced(fb, scene) : renderWalls(fb, scene, glows)` (`RoomScene` satisfies `TracedScene` when
  `traced` is set; narrow with a small guard, no cast). `game.ts`: `createTracedRoom(map, textures, flags.lights)`.
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck` — PASS. In `pnpm dev`, choose "Ray traced" in the console: the lit
  room shows, then within about a second the traced one. With `?lights=off` it stays flat.
- [ ] **Step 5: Bench.** Move `posesNearLamps` and `crowdGlows` from `bench/walls.ts` to `bench/poses.ts` unchanged and
  confirm `pnpm bench:walls` output is byte-identical (save it before, `diff` after). `bench/traced.ts` prints: cold
  bake ms, ms per frame over the poses, the same with 100 crowd sprites, and a pixel hash. Add
  `"bench:traced"` to the root `package.json`, mirroring `bench:walls`.
- [ ] **Step 6: Docs.** `docs/open-decisions.md`: D25 under Resolved (2026-10-17: a second, switchable ray-traced
  renderer; pure rays; link the spec). `AGENTS.md`: the `pnpm bench:traced` line under Commands, and one gotcha bullet
  (traced mode lives in `renderer/traced/`, replaces `renderWalls` only, bakes in 6 ms slices with the lit renderer
  until ready, pure rays: lampless rooms are dark by design).
- [ ] **Step 7: Commit** "Switch the room to the traced renderer when chosen".
- [ ] **Step 8: Phone checkpoint (stop here).** Ask the owner to try "Ray traced" (tray → Lighting) on their phone in
  a room with 8 people on video. Bar (spec §4): the frame-rate meter stays "good" (55 fps). The console doesn't open on
  touch and the meter isn't exposed elsewhere, so the owner judges by walking and turning (no stutter next to the
  current renderer). If missed: set the touch reflection scale to ¼ once
  Task 9 exists, move the bake to a Worker (write that as a follow-up plan), and if still missed, stop and decide with
  the owner.

### Task 9: Reflections of walls, floor, ceiling and lamps

**Files:**
- Create: `apps/web/src/renderer/traced/reflections.ts`, `apps/web/src/renderer/traced/along-ray.ts` (lamps — and in
  Task 10 people — near a 2D ray)
- Modify: `apps/web/src/renderer/traced/frame.ts`, `apps/web/src/renderer/traced/buffers.ts`
- Test: `apps/web/src/renderer/traced/reflections.test.ts`

**Interfaces:**
- Consumes: Tasks 6–7 (`fresnel`, `blobWeight`, per-pixel Fresnel and tile id).
- Produces: `REFLECTION_SCALE = 2` (one constant: the phone fallback sets 4); `traceReflections(state)` fills a linear
  rgb buffer `(W/2)×(H/2)`; the composite becomes `diffuse·(1 − F) + F·tint·reflection`, tint per tile id =
  `1 − tint + tint·mean/max(mean)` (floor: neutral), reflection blended up bilinearly (rows widened to W first, then two
  rows per pixel).

- [ ] **Step 1: Write the failing tests** (LEVEL1 baked once; poses from the spike, all at 640×360, FOV 66°):
  - eye (34.5, 33.0) facing π/2 (a blue corridor, lamps ahead): the nearer lamp makes one streak in the floor's
    reflection: along the reflection-buffer column through it, values rise to a single peak and fall, and along the row
    through the peak they fall off monotonically for ≥ 3 samples each side (no plateau, no hard edge: the box-blur
    failure).
  - eye (41.5, 6.2) facing −π/2 − 0.5 (the wood room): the brightest reflection on the far wood wall has
    red > green > blue (golden tint).
  - in the blue corridor pose, the walls' reflections have blue > red (bluish sheen).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Per reflection column (frame column `rx·2 + 1`, rows `ry·2 + 1`):
  ceiling rows reflect nothing; **wall rows**: one mirrored `castRay` per column (flip the normal component, start
  1e−4 off the face), per row `k = (half − (y+0.5))/proj`, `zh = 0.5 + k·d`, `zWall = zh + k·sWall`,
  `edge = max(0.02, α·sWall·len)` with α = roughness²; the far wall and the floor/ceiling past its foot/top blend by
  share over `edge`; texture fades to mean by cone width/0.25, plane light to the soft copy by cone/1; slant =
  `|n·ray|/len` (≥ 0.1) stretches the cone across. Rough walls (α > 0.25): trace every 4th row, blend between.
  **Floor rows**: `t = 0.5/slope`, the mirrored ray climbs at `slope` along the column's own ray (no walk),
  `zWall = slope·(d − t)`, `edge = max(0.02, α·(d − t)·len / slant)`, slant = `slope/sqrt(len² + slope²)` (≥ 0.1),
  stretch up the screen. **Lamps** meet the cone where it reaches the ceiling: `blobWeight(o, (s − sCeiling)·len, r,
  spreadAcross, spreadAlong)` with spreadAlong divided by the ray's rise (≥ 0.1), times the ceiling's share. Lamps along
  a ray come from `along-ray.ts`: lamps within 12 tiles of the eye listed once per frame, kept per ray if
  `|o| < r + min(2, 3·spread per unit s·s)`, nearest 12 by s. Reference: `spikes/raytrace/render.ts`
  `reflectOffWall`, `reflectOffFloor`, `addCeilingLamp`, `widenReflections`.
- [ ] **Step 4: Run** tests and `pnpm bench:traced` (note ms at ½) — PASS. **Step 5: Commit** "Trace reflection
  cones in the traced room".

### Task 10: People in reflections, and crowds

**Files:**
- Modify: `apps/web/src/renderer/traced/along-ray.ts`, `apps/web/src/renderer/traced/reflections.ts`,
  `apps/web/src/renderer/glow.ts` (export `averageFace`), `apps/web/src/renderer/sprites.ts` (export `FACE_RADIUS`)
- Test: `apps/web/src/renderer/traced/reflections.test.ts`

**Interfaces:**
- Consumes: `Sprite` (`x`, `y`, `bob`, `face`, `color`), `AVATAR_RADIUS`, `BOB_HEIGHT`, `EYE_HEIGHT`, `FACE_RADIUS`,
  `averageFace(face: Uint32Array): { r: number; g: number; b: number }`.
- Produces: people listed per frame with lamps (within 12 tiles of the eye), disc centre
  `EYE_HEIGHT + bob·BOB_HEIGHT·AVATAR_RADIUS`; `FACE_REFLECTION_GAIN = 0.3` (a face's linear colour × this, about how
  bright its screen colours look at exposure 4).

- [ ] **Step 1: Write the failing tests:**
  - a person standing between the eye and a wood wall, seen at a grazing angle, appears in the wall's reflection: the
    reflection buffer near the mirrored position has the ring colour's hue (sharp: cone < 0.3 radius).
  - on the rough floor, the same person's reflection is a blob of the face's average colour (`face` set) or the ring
    colour (`face: null`).
  - 100 people spread over LEVEL1: `renderTraced` completes, writes every pixel, and a person 2 tiles ahead still
    reflects.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** A person meets the cone sharp (face texel via `FACE_RADIUS` and
  the face's side length, or ring) while `cone < 0.3·r`, else as `blobWeight` laid over what's behind (far to near).
  Face averages are taken once per frame per listed person (sRGB → linear via a 256-entry table).
- [ ] **Step 4: Run** tests, `pnpm bench:traced` with the crowd, `pnpm bench:sprites` (hash unchanged) — PASS.
  **Step 5: Commit** "Reflect people in the traced room".

### Task 11: The vacuum lit by the traced room

**Files:**
- Modify: `apps/web/src/renderer/voxels.ts`, `apps/web/src/renderer/sprites.ts`, `apps/web/src/renderer/frame.ts`
- Create: `apps/web/src/renderer/traced/objects.ts`
- Test: `apps/web/src/renderer/traced/objects.test.ts`

**Interfaces:**
- Produces: `VoxelLight = (v: VoxelInstance, out: Float64Array) => void` (fills 5 directions × rgb, `DIR_*` order, as
  multipliers on the face's colour, like `lightDirections`); `renderVoxel(fb, view, v, lighting = null,
  objectLight: VoxelLight | null = null)` (`objectLight` wins when given); `PeopleAndObjects.objectLight?: VoxelLight |
  null`; `tracedObjectLight(lighting: TracedLighting): VoxelLight` (made once per `TracedLighting`, cached by
  `frame.ts`).

- [ ] **Step 1: Write the failing tests:** a vacuum under a lamp gets a larger top multiplier than one 6 tiles from any
  lamp; the top multiplier exceeds the side ones under a ceiling lamp; existing `voxels.test.ts` passes untouched.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Per direction (top `(0,0,1)`, front/back/right/left from
  `v.angle`), irradiance `E = lampLight` at the model's mid-height + `floorBounce` at (x, y) (bilinear). Multiplier per
  channel = `shown(0.2·E) / srgb(0.2)`: `shown(v)` is the sRGB value `shownPixel` gives a grey of linear radiance `v`,
  and `srgb(0.2)` the sRGB value of linear 0.2, the colour as authored. So a face looks as a mid grey would under that
  light in the traced room, relative to its own colour.
- [ ] **Step 4: Run** `pnpm test`, `pnpm bench:sprites` (hash unchanged) — PASS. **Step 5: Commit** "Light the
  vacuum from the traced bake".

### Task 12: Frame-rate guard, docs, and the final phone check

**Files:**
- Modify: `apps/web/e2e/frame-rate.spec.ts`, `docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md`
  (status line), `AGENTS.md` (if Tasks 9–11 changed what the gotcha says)

- [ ] **Step 1:** Run the existing frame-rate test a second time with the traced mode: before load,
  `page.addInitScript(() => localStorage.setItem('zoom3d.render.v1', JSON.stringify({ mode: 'traced' })))`; wait 2 s
  for the bake; expect the same median `< 20` ms.
- [ ] **Step 2:** Run everything: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm e2e`, `pnpm bench:walls` (diff
  against the saved output: identical), `pnpm bench:sprites` (hash unchanged), `pnpm bench:traced` (record the
  numbers in the spec's §4).
- [ ] **Step 3:** Spec status → "approved design, implemented <date>"; commit "Guard the traced room's frame rate".
- [ ] **Step 4: Phone check with the owner** against the bar (spec §4), now with reflections and people. Apply the
  owner's fallback if missed (¼ via `REFLECTION_SCALE` on touch, Worker bake as a follow-up plan).
