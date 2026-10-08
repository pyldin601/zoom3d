# M0+M1 Single-Player Walk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One person can open the web app and walk around the converted level in a retro
ray-cast view, in a fixed 16:9 letterboxed viewport, with a toggleable automap.

**Architecture:** A pnpm monorepo with these parts:
- `packages/shared`: pure TypeScript. Map parsing and validation, ray casting, movement and
  collision, viewport math, spawn. All of it is unit-tested with Vitest.
- `apps/web`: a Vite app. The software renderer writes into a `Uint32Array` framebuffer
  (pure and tested). The rest is browser glue: input, game loop, canvases, automap drawing.
- `tools/convert-map`: a one-off Python converter. The map it generates is committed and
  becomes the source of truth.

**Tech Stack:** Node 22, pnpm 9 workspaces, TypeScript 5 (strict), Vite 6, Vitest 3, Playwright, Biome, Python 3 (stdlib only, converter).

**Spec:** [docs/superpowers/specs/2026-10-08-zoom3d-design.md](../specs/2026-10-08-zoom3d-design.md): §3 layout, §4 map, §5 rendering (walls, z-buffer, fixed aspect, HUD canvas, automap, hot path), §6 movement, §11 testing. Billboards, labels, networking and audio belong to later milestones.

## Global Constraints

- TypeScript `strict: true`. ES modules everywhere. `packages/shared` has **no runtime dependencies** and no DOM types.
- Coordinates: map `x` goes right (columns), `y` goes down (rows), in continuous tile units.
  `angle` is in radians, with 0 = facing +x. An increasing angle turns clockwise on the map
  (turning right).
- Tile ids: `0` floor, `1` stone (grey), `2` wood (brown), `3` blue stone. Out-of-bounds counts as wall `1`.
- Internal framebuffer: **640×360**, always 16:9. FOV **66°** horizontal. Projection constant
  `PROJ = (W/2) / tan(FOV/2)`, so a wall at perpendicular distance `d` is `PROJ/d` px tall
  (square tiles, no stretch).
- Movement: **3 tiles/s**, turning **2.5 rad/s**, player radius **0.25**, `dt` clamped to **0.1 s**.
  Mouse turning uses **0.0025 rad per px** of `movementX` under pointer lock.
- Textures: **64×64**, procedural and deterministic per wall type (seeded PRNG). y-side walls
  (DDA `side === 1`) are shaded to 70% brightness. Ceiling `#383838`, floor `#707070`.
- Upscaling uses `imageSmoothingEnabled = false`. The viewport is the largest centred 16:9 box,
  letterboxed in black. The HUD canvas covers the same box, with backing size = box × `devicePixelRatio`.
- **No allocations per frame or per column** in `renderWalls` and `castRay`: they use typed
  arrays and out-parameters.
- Spawn: a random floor tile within Euclidean radius 2 (tile centres) of `S`, facing a random
  open cardinal direction.

## Review Focus

1. **Axis-aligned rays and integer positions:** a ray with `dirX === 0` or `dirY === 0`, or a
   player exactly on a tile edge, must yield a finite hit with no NaN and no infinite loop.
   Test in Task 3.
2. **Diagonal movement into a corner:** the player must neither pass through the corner nor
   stick. Pushing along a wall slides. Test in Task 4.
3. **Huge `dt`** after a hidden tab resumes (rAF delivers seconds): no tunnelling through
   walls. `dt` is clamped. Test in Task 4.
4. **Degenerate window sizes:** 0×0 during layout, 1×1, or extreme aspect ratios must give a
   non-negative, finite box with no NaN. Test in Task 5.
5. **Stuck keys:** a key held while the window loses focus must not keep the player walking.
   Input resets on `blur` and `visibilitychange`. Test in Task 7.

---

### Task 1: Monorepo tooling

**Files:**
- Create: `package.json` (root, `"private": true`, `"packageManager": "pnpm@9.15.9"`; scripts: `dev` → `pnpm --filter @zoom3d/web dev`, `test` → `vitest run`, `typecheck` → `tsc -b`, `lint` → `biome check .`, `e2e` → `pnpm --filter @zoom3d/web e2e`)
- Create: `pnpm-workspace.yaml` (`apps/*`, `packages/*`)
- Create: `tsconfig.base.json` (strict, `target` ES2022, `module` ESNext, `moduleResolution` Bundler, `noUncheckedIndexedAccess` true, `composite` true), plus `tsconfig.json` with references to both packages
- Create: `vitest.config.ts` (root, `test.projects: ['packages/*', 'apps/*']`)
- Create: `biome.json` (formatter: 2 spaces, single quotes, line width 110; ignore `dist`, `spikes`, `tools`)
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts}` (name `@zoom3d/shared`, `exports: "./src/index.ts"`)
- Create: `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.ts}` (name `@zoom3d/web`, depends on `@zoom3d/shared: workspace:*`; `tsconfig` lib includes `DOM`)
- Create: `packages/shared/src/smoke.test.ts`: `expect(1 + 1).toBe(2)`, removed in Task 2
- Modify: `.gitignore` (add `.superpowers/`), `AGENTS.md` (Commands section)

- [ ] **Step 1: Write the files above. Install dev deps at the root:** `typescript`, `vitest`, `@biomejs/biome`, `vite`, `@playwright/test` (latest versions released at least two weeks ago)
- [ ] **Step 2: Verify the toolchain**

Run: `pnpm install && pnpm test && pnpm typecheck && pnpm lint`
Expected: 1 test passes; tsc and biome exit 0.

Run: `pnpm dev` (background), then `curl -s localhost:5173 | grep -c '<canvas'`
Expected: `1` (the index.html has `<canvas id="game">` and `<canvas id="hud">` inside `<div id="stage">`).

- [ ] **Step 3: Fill in the AGENTS.md Commands section** with `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm e2e`.
- [ ] **Step 4: Commit:** `chore: pnpm monorepo with vite, vitest, biome, typescript`

### Task 2: Level conversion and map parsing

**Files:**
- Create: `tools/convert-map/convert.py` (Python 3 stdlib only)
- Create: `packages/shared/src/map/level1.ts` (generated: `export const LEVEL1 = \`...\`;`)
- Create: `packages/shared/src/map/map.ts`
- Test: `packages/shared/src/map/map.test.ts`
- Modify: `packages/shared/src/index.ts` (re-exports); delete `smoke.test.ts`

**Converter algorithm (parameters measured from `docs/assets/map-reference.png`):**
- Decode the PNG with `zlib` (8-bit RGB, non-interlaced, all 5 filter types).
- The grid is **63×57**. Tile pitch is **7.985 px**, origin `(1.5, 0.4)`. Tile `(tx, ty)` covers
  pixels from `(1.5 + 7.985·tx, 0.4 + 7.985·ty)`.
- **Classify** from the tile's central 4×4 pixels (offsets 2..5). A pixel is non-black if
  `max(r, g, b) > 20`. With ≥ 8 non-black pixels, the tile is a wall, typed by its dominant
  pixel class:
  - blue (`b > 60, r < 30, g < 30`) → `3`
  - brown (`r > g+10 > b+20`) → `2`
  - grey (channels within 12) → `1`
  - green (`g > r+40` and `g > b+40`), red or yellow markers → wall of the majority type among its 4 neighbours (default `1`)

  Otherwise the tile is floor `.`.
- **Thin-line tiles:** floor tiles with ≥ 4 non-black pixels in the full 8×8 tile (door lines).
- **Spawn:** the tile containing pixel `(238, 405)`, which is the blue diamond, is `S`.
- **Seal leaks:** repeat a BFS from `S` over floor tiles. If it reaches the grid border, take
  the BFS path, convert the thin-line tile on it nearest the border into a wall (majority
  neighbour type), and repeat. If a leak path has no thin-line tile, exit non-zero and print
  the path.
- **Finish:** every tile not reached from `S` becomes a wall (its own type if it was a wall,
  else `1`), so secret rooms and the void become solid. Write
  `packages/shared/src/map/level1.ts`, and print the floor count and sealed tiles.
- Expected output: spawn `(29, 50)`, 25 sealed tiles, about 989 floor tiles reachable.

**Interfaces:**
- Produces:
  - `export interface GameMap { width: number; height: number; tiles: Uint8Array; spawn: { x: number; y: number } }`
    (`tiles[y * width + x]`; `spawn` is the S tile index)
  - `export function parseMap(text: string): GameMap`, which accepts `.` `1` `2` `3` `S`,
    trims surrounding blank lines, and throws `Error` with a message naming the row for
    non-rectangular input, an unknown char, or a spawn count other than 1
  - `export function tileAt(map: GameMap, x: number, y: number): number`, with integer x and y;
    out of bounds returns `1`
  - `export function isWallAt(map: GameMap, x: number, y: number): boolean`, which floors continuous coordinates
  - `export function validateMap(map: GameMap): string[]`, listing violations: a border tile
    that isn't a wall, or floor unreachable from spawn (4-neighbour flood fill)
  - `export function spawnPoint(map: GameMap, rng: () => number): { x: number; y: number; angle: number }`,
    returning a tile centre (`+0.5`) and an angle among `0, π/2, π, 3π/2` whose adjacent tile is floor
  - `export const LEVEL1: string`

- [ ] **Step 1: Write the converter, run it, and commit its output.** Run: `python3 tools/convert-map/convert.py`. Expected: prints `spawn (29, 50)`, `sealed 25`, and a reachable count, and writes `level1.ts`.
- [ ] **Step 2: Write failing tests in `map.test.ts`:**
  - `parseMap` of `"111\n1S1\n111"` gives width 3, height 3, `spawn {x:1,y:1}`, and `tiles[4] === 0`
  - throws on `"11\n111"` (message contains `row 2`), on `"1x1"`, on two `S`, and on zero `S`
  - `tileAt(map, -1, 0) === 1`; `isWallAt(map, 1.9, 1.2) === false` on the 3×3 map
  - `validateMap` returns `[]` for the 3×3 map and reports a non-wall border on `"1.1\n1S1\n111"`
  - `validateMap(parseMap(LEVEL1))` deep-equals `[]`; the level is 63×57 with spawn `{x:29, y:50}`
  - `spawnPoint` with rngs `() => 0` and `() => 0.999`: the result is on floor, within radius
    2.0 of the spawn centre, and the tile one step along `angle` is floor
- [ ] **Step 3: Run** `pnpm test`. Expected: FAIL (`parseMap` not exported).
- [ ] **Step 4: Implement `map.ts`.**
- [ ] **Step 5: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 6: Commit:** `feat(shared): level1 map from reference image, parser and validation`

### Task 3: Ray casting (DDA)

**Files:**
- Create: `packages/shared/src/geometry/raycast.ts`
- Test: `packages/shared/src/geometry/raycast.test.ts`

**Interfaces:**
- Consumes: `GameMap` and `tileAt` from Task 2.
- Produces:
  - `export interface RayHit { distance: number; mapX: number; mapY: number; side: 0 | 1; wallX: number; tile: number }`
    - `distance` is the perpendicular distance along the ray direction, which must be unit
      length for true distance. Callers pass the camera ray, whose length ≥ 1.
    - `side` is 0 if an x-side (vertical grid line) was hit, 1 for a y-side.
    - `wallX` is in [0, 1), the fractional hit position along the wall face.
  - `export function createRayHit(): RayHit`
  - `export function castRay(map: GameMap, px: number, py: number, dirX: number, dirY: number, out: RayHit, maxSteps = 256): RayHit`.
    This is the classic Lode-style DDA with `deltaDist = dir === 0 ? Infinity : |1/dir|`.
    It writes into `out` and returns it. If `maxSteps` runs out, it reports `distance = Infinity`, `tile = 0`.

- [ ] **Step 1: Write failing tests** on the grid `"11111\n1...1\n1.S.1\n1...1\n11111"`, from `(2.5, 2.5)`:
  - dir `(1, 0)`: `distance` is 1.5, `mapX` 4, `side` 0, `wallX` 0.5
  - dir `(0, -1)`: `distance` is 1.5, `mapY` 0, `side` 1
  - from `(2, 2)` (integer position) with dir `(1, 0)`: distance 2, finite (Review Focus 1)
  - dir `(1, 1)` normalised: finite distance in (1.4, 2.2), never NaN
  - an open map (`"S.."`, single row, out of bounds counts as wall) with dir `(-1, 0)` from `(0.5, 0.5)`: distance 0.5
  - `castRay` returns the same `out` object (identity)
  - golden on `LEVEL1` from the spawn centre `(29.5, 50.5)`, rays facing east and north: distances equal to hand-counted tile gaps
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement `castRay`.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit:** `feat(shared): DDA ray casting`

### Task 4: Movement and collision

**Files:**
- Create: `packages/shared/src/geometry/movement.ts`
- Test: `packages/shared/src/geometry/movement.test.ts`

**Interfaces:**
- Consumes: `isWallAt` from Task 2.
- Produces:
  - `export const MOVE_SPEED = 3, TURN_SPEED = 2.5, PLAYER_RADIUS = 0.25, MAX_DT = 0.1`
  - `export interface PlayerState { x: number; y: number; angle: number }`
  - `export interface MoveInput { forward: number; strafe: number; turn: number }`: each in
    [-1, 1]; `strafe` +1 = right; `turn` +1 = turn right (angle increases)
  - `export function moveWithCollision(map: GameMap, x: number, y: number, dx: number, dy: number, radius = PLAYER_RADIUS): { x: number; y: number }`.
    Axis-separated: apply dx, and revert it if any of the 4 corners of the radius box is in a
    wall; then do the same for dy.
  - `export function stepPlayer(map: GameMap, s: PlayerState, input: MoveInput, dt: number, out: PlayerState): PlayerState`.
    It clamps `dt` to `[0, MAX_DT]`, normalises the diagonal input vector to length ≤ 1,
    wraps `angle` into `[0, 2π)` and writes `out`.

- [ ] **Step 1: Write failing tests** on the 5×5 room from Task 3:
  - forward 1 for dt 0.1 at angle 0 from `(2.5, 2.5)` gives `x ≈ 2.8`
  - forward 1 for 50 steps of dt 0.1 gives `x ≤ 4 - 0.25`, i.e. the player stops at the wall
  - `stepPlayer` with dt 5 moves at most `MOVE_SPEED * MAX_DT = 0.3` (Review Focus 3)
  - 20 steps of dt 0.1 moving diagonally `(+, +)` into the corner from `(3.5, 3.5)`: final
    `x` and `y` are each in `(3.5, 3.75]`, and no step's position has a radius-box corner in a
    wall (Review Focus 2)
  - sliding: from `(3.7, 2.0)` at angle π/4, forward for dt 0.1: `x ≤ 3.75` and `y > 2.1`
  - forward 1 + strafe 1 moves `MOVE_SPEED * dt` in total (normalised), not √2 times that
  - turn 1 for dt 0.1 adds 0.25 rad, and the angle wraps from `2π - 0.1` past 0
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit:** `feat(shared): player movement with wall sliding`

### Task 5: Viewport fitting

**Files:**
- Create: `packages/shared/src/viewport.ts`
- Test: `packages/shared/src/viewport.test.ts`

**Interfaces:**
- Produces:
  - `export const INTERNAL_W = 640, INTERNAL_H = 360`
  - `export interface ViewportBox { x: number; y: number; width: number; height: number }` (CSS px, integers)
  - `export function fitViewport(windowW: number, windowH: number, pixelPerfect = false): ViewportBox`.
    This is the largest 16:9 box inside the window, centred, with integer values (width floored
    to a multiple of 16 so that height = width·9/16 is exact). With `pixelPerfect`, the scale is
    the largest integer `k ≥ 1` with `640k ≤ W` and `360k ≤ H`; if even k = 1 doesn't fit, it
    falls back to the non-integer fit.

- [ ] **Step 1: Write failing tests:**
  - `1920×1080` gives `{0, 0, 1920, 1080}`
  - `1920×1200` gives width 1920, height 1080, y 60
  - `800×1000` gives width 800, height 450, y 275
  - `333×777` gives width 320, height 180, centred
  - for every case, `width * 9 === height * 16`, the box lies inside the window, and all values are integers ≥ 0
  - `0×0` and `1×1` give `{0, 0, 0, 0}`-style finite boxes, no NaN (Review Focus 4)
  - `pixelPerfect` at `1500×900` gives width 1280, height 720, x 110, y 90
  - `pixelPerfect` at `500×300` falls back to width 496, height 279 (still 16:9: 496·9 = 279·16)
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit:** `feat(shared): fixed 16:9 viewport fitting`

### Task 6: Software wall renderer

**Files:**
- Create: `apps/web/src/renderer/framebuffer.ts`, `apps/web/src/renderer/textures.ts`, `apps/web/src/renderer/walls.ts`
- Test: `apps/web/src/renderer/walls.test.ts`

**Interfaces:**
- Consumes: `castRay`, `createRayHit` (Task 3); `PlayerState` (Task 4); `INTERNAL_W`, `INTERNAL_H` (Task 5).
- Produces:
  - `export interface Framebuffer { width: number; height: number; pixels: Uint32Array; zbuffer: Float64Array }`.
    `pixels` is in the `ImageData` little-endian layout `0xAABBGGRR`; `zbuffer` has length `width`.
  - `export function createFramebuffer(width = INTERNAL_W, height = INTERNAL_H): Framebuffer`
  - `export function rgb(r: number, g: number, b: number): number`, which packs to `0xFFBBGGRR`
  - `export const TEX = 64`
  - `export function makeTextures(seed = 1): Uint32Array[]`. Index 1–3 are 64×64 textures
    (stone blocks, wood planks, blue stone), generated with a mulberry32 PRNG; index 0 is unused.
  - `export const FOV = (66 * Math.PI) / 180, CEILING = rgb(0x38,0x38,0x38), FLOOR = rgb(0x70,0x70,0x70)`
  - `export function renderWalls(fb: Framebuffer, map: GameMap, p: PlayerState, textures: Uint32Array[]): void`.
    Per column: the camera ray is `dir + plane·cameraX`, where `plane` is perpendicular to dir
    with length `tan(FOV/2)`. Wall height is `PROJ / distance`, with
    `PROJ = (width/2) / tan(FOV/2)`. It is vertically centred and clipped. Texture u comes from
    `wallX` (mirrored so textures read left to right on both sides). y-sides are shaded to 70%.
    Ceiling and floor are filled flat. `zbuffer[col] = distance`. No allocations: reuse one
    module-level `RayHit`.

- [ ] **Step 1: Write failing tests** with player `(2.5, 2.5, angle 0)` in the 5×5 room and a 640×360 framebuffer:
  - the centre column `zbuffer[320]` ≈ 1.5
  - the centre column's wall height is ≈ `PROJ / 1.5` (≈ 328.5 px): count the non-ceiling,
    non-floor pixels in column 320, within ±2
  - `pixels[0]` (top-left) is `CEILING` and the last pixel is `FLOOR`, when the wall height is < 360 at the edges
  - every pixel has alpha `0xFF` after render
  - `makeTextures(1)` is deterministic: two calls give equal arrays; textures 1, 2 and 3 differ
  - a y-side hit pixel is darker than the same texel on an x-side: compare the average brightness of column 320 at angle 0 vs angle π/2 (the same texture tile type)
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Benchmark (logged, not gating):** `apps/web/src/renderer/walls.bench.ts` with Vitest `bench`, 640×360 on LEVEL1 from spawn. Run: `pnpm vitest bench --run`. Record the mean ms per frame in the commit message (spec budget: < 8 ms).
- [ ] **Step 6: Commit:** `feat(web): textured software wall renderer (<mean> ms/frame)`

### Task 7: Game shell: viewport, input, loop

**Files:**
- Create: `apps/web/src/input/keyboard.ts`, `apps/web/src/game/loop.ts`, `apps/web/src/game/stage.ts`
- Modify: `apps/web/src/main.ts`, `apps/web/index.html`
- Test: `apps/web/src/input/keyboard.test.ts`
- Create: `apps/web/e2e/viewport.spec.ts`, `apps/web/playwright.config.ts` (Chromium, `webServer` = `pnpm dev`)

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `export function createInput(target: Pick<Window, 'addEventListener'>, doc: Pick<Document, 'addEventListener' | 'visibilityState'>): { state(): MoveInput; consumeMouseTurn(): number; reset(): void }`.
    - Key bindings by `KeyboardEvent.code`: W/↑ forward, S/↓ back, A strafe left, D strafe right, ←/→ turn, Q/E turn.
    - Mouse `movementX` accumulates turn only while pointer-locked; `consumeMouseTurn()`
      returns radians (0.0025 rad/px) and zeroes the accumulator.
    - `reset()` clears all keys and runs on window `blur` and on `visibilitychange` to hidden (Review Focus 5).
  - `export function layoutStage(stage: HTMLElement, game: HTMLCanvasElement, hud: HTMLCanvasElement, pixelPerfect: boolean): ViewportBox`.
    It applies `fitViewport(innerWidth, innerHeight)` to `#stage` (absolute position and size)
    and sizes the HUD backing store to `box × devicePixelRatio`. The game canvas backing stays
    640×360, and CSS scales it with `image-rendering: pixelated`. It runs from a
    `ResizeObserver` on `document.documentElement` and a `matchMedia` dpr listener.
  - `export function startLoop(tick: (dt: number) => void): () => void`: rAF, `dt` in seconds from timestamps, returns stop.
- `main.ts` does the following:
  - parses LEVEL1 and calls `spawnPoint(map, Math.random)`
  - on each tick: `stepPlayer` with `input.state()` plus the mouse turn, `renderWalls`, then `putImageData` into the game canvas
  - requests pointer lock on canvas click
  - the body background is black, which forms the letterbox

- [ ] **Step 1: Write failing tests in `keyboard.test.ts`** with fake event targets (record listeners and dispatch plain objects):
  - KeyW down gives `forward 1`; KeyW + KeyS gives 0
  - ArrowRight gives `turn 1`
  - KeyW down, then window `blur`, gives `forward 0` (Review Focus 5)
  - KeyW down, then `visibilitychange` with `visibilityState 'hidden'`, gives `forward 0`
  - mouse movementX 100 while locked: `consumeMouseTurn()` is 0.25, then 0
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement `keyboard.ts`, `loop.ts`, `stage.ts` and `main.ts`.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Write the Playwright test `viewport.spec.ts`.** For window sizes 1280×720,
  1280×1024, 900×1400 and 1500×600, `#stage`'s bounding box has `width/height` within 0.01 of
  16/9, lies fully inside the window, and is centred within 1 px. `#hud.width` equals
  `round(box.width × devicePixelRatio)`.

Run: `pnpm e2e`. Expected: 4 passed.
- [ ] **Step 6: Manual check in the browser.** `pnpm dev`, then walk around: no wall
  clipping, sliding works, textures are not stretched, and resizing the window keeps the
  letterbox with no distortion.
- [ ] **Step 7: Commit:** `feat(web): game shell with fixed 16:9 stage, input and loop`

### Task 8: Automap

**Files:**
- Create: `apps/web/src/renderer/automap.ts`
- Test: `apps/web/src/renderer/automap.test.ts`
- Modify: `apps/web/src/main.ts` (Tab/M toggles, drawn on the HUD canvas each frame while visible; Tab `preventDefault`)

**Interfaces:**
- Consumes: `GameMap`, `PlayerState`, `ViewportBox` (backing pixels = box × dpr).
- Produces:
  - `export function automapLayout(map: GameMap, hudW: number, hudH: number): { originX: number; originY: number; cell: number }`.
    The map fits within 90% of the HUD canvas, centred; `cell` is a whole number of
    pixels ≥ 1, the largest that fits.
  - `export function drawAutomap(ctx: CanvasRenderingContext2D, map: GameMap, p: PlayerState, hudW: number, hudH: number): void`.
    It draws a semi-transparent black backdrop, wall cells in the zone colours (`1` `#8c8e8c`,
    `2` `#7a5530`, `3` `#1a2cc0`) only where a wall touches floor (8-neighbourhood), floor cells
    unpainted, and the player as a yellow triangle pointing along `angle`.
    M2 adds participant dots.

- [ ] **Step 1: Write failing tests:**
  - `automapLayout(LEVEL1 map, 1920, 1080)`: `cell` is 17 (⌊min(1728/63, 972/57)⌋ = 17), and the map is centred (originX = (1920 − 63·17)/2 floored)
  - a 1×1 HUD gives `cell` 1, no NaN
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement it and wire the toggle.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm lint`. Expected: all green.
- [ ] **Step 5: Manual check:** press M. The map matches `docs/assets/map-conversion-preview.png`,
  the arrow tracks the player position and heading, and the automap stays inside the 16:9 box
  when the window is resized.
- [ ] **Step 6: Commit:** `feat(web): toggleable automap`
