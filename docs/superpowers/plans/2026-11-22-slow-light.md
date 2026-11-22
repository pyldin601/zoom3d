# Slow Light Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-person "slow light" look: remote things drawn where they were when their light left them, and the
view bent, tinted and brightened by the local player's own motion, with a console toggle and a c slider.

**Architecture:** Light delay adds distance ÷ c to each remote thing's drawn time in `RemoteWorld.sample` (one
delay per thing). Bending is a post-process: with the look on, `renderView` draws into a 2×-wide 130° source frame,
then a per-column table resamples it into the normal frame with a per-column RGB multiplier; first-person items are
drawn after, unbent. The look off takes none of these paths.

**Tech Stack:** TypeScript, vitest, Biome; software framebuffer (`Uint32Array`, 0xAABBGGRR).

**Spec:** `docs/superpowers/specs/2026-11-22-slow-light-design.md`

## Global Constraints

- The look off draws today's frame pixel for pixel: `pnpm bench:walls` and `pnpm bench:sprites` hashes unchanged.
- No allocations per frame or per column on the look's paths (typed arrays and pooled objects, filled in place).
- Buffers are rebuilt only when the frame's size or FOV changes, or the look turns on, never per frame.
- Nothing goes on the wire; the server is untouched; gameplay (moves, kicks, E, `useChoice`) reads true positions.
- c slider: 6–60 tiles/s, step 1, default 12. β = |v| / c capped at **0.5** (bend, tint, searchlight only).
- Source frame: FOV **130°**, width **2×** the frame's (one named constant), same height.
- 1 tile ≈ 0.47 m (walking 3 tiles/s ≈ 1.4 m/s): the slider shows tiles/s and m/s.
- Code style: Biome (`pnpm exec biome check --write .`), braced bodies, `.at()` over `arr[i] as T`, names with units,
  comments only say why, no "you/your" in identifiers, comments or test titles (UI text excepted).
- Test first for every piece of logic; commit after each task, imperative mood, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Walking through a portal: the own position jumps; the measured velocity must not spike (Task 3 test).
2. A peer that just joined (one snapshot) or whose delay outgrows the history: drawn at the oldest pose, never
   skipped (Task 5 test).
3. The tall touch FOV (`FOV_TALL`, 50°) and the wide one: every table entry stays inside the source frame at β = 0.5
   in every direction (Task 2 test).
4. Toggling the look on and off, or the frame resizing: the source frame is rebuilt once, then the same object reused
   (Task 4 test).
5. c at 6 while riding at 6 tiles/s: β clamps to 0.5, no NaN from `acos` or `√(1 − β²)` (Task 2 and Task 3 tests).

---

### Task 1: Settings and console rows

**Files:**
- Modify: `apps/web/src/ui/render-settings.ts`
- Modify: `apps/web/src/ui/console-panel.ts` (`renderRows`)
- Test: `apps/web/src/ui/render-settings.test.ts`, `apps/web/src/ui/console-panel.test.ts`

**Interfaces:**
- Produces: `type LightLook = 'instant' | 'slow'`; `RenderSettings` gains `light: LightLook` and
  `lightSpeed: number` (tiles/s); `LIGHT_LOOKS`, `LIGHT_LOOK_NAMES` (`{ instant: 'Instant', slow: 'Slow' }`);
  `LIGHT_SPEED_MIN = 6`, `LIGHT_SPEED_MAX = 60`, `DEFAULT_LIGHT_SPEED = 12`; `METRES_PER_TILE = 0.47`.

- [ ] **Step 1: Write the failing tests** in `render-settings.test.ts`:
  - `defaults light to instant at 12 tiles/s`: `normalizeRenderSettings(null)` has `light: 'instant'`,
    `lightSpeed: 12`.
  - `keeps a stored slow look and its speed`: `{ light: 'slow', lightSpeed: 20 }` → same.
  - `falls back alone for a bad light or speed`: `{ mode: 'shadows', light: 'warp', lightSpeed: 'fast' }` →
    `mode: 'shadows'`, `light: 'instant'`, `lightSpeed: 12`.
  - `clamps and rounds the speed into the slider's range`: 2 → 6, 500 → 60, 12.6 → 13, `NaN` → 12.
  And in `console-panel.test.ts`, following its existing row tests: the panel shows a `Light` select with Instant/Slow
  and a `Speed of light` range input (min 6, max 60, step 1); moving it calls `onChange` with the new `lightSpeed`,
  and its text reads `12 tiles/s (5.6 m/s)` at 12.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/ui/render-settings.test.ts src/ui/console-panel.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the types and constants above; `normalizeRenderSettings` checks `light` and
  `lightSpeed` each on its own (`Math.round`, then clamp; non-finite → default). In `renderRows` add
  `selectRow('Light', LIGHT_LOOKS, LIGHT_LOOK_NAMES, ...)` and a `rangeRow('Speed of light', ...)` beside it; the
  range's `input` event updates the text, `change` calls `choose({ lightSpeed })` (widen `choose`'s patch type to
  `Partial<RenderSettings>`-compatible values).
- [ ] **Step 4: Run** the same command — expect PASS. Run `pnpm typecheck`.
- [ ] **Step 5: Commit** — `Add the slow light look and its speed to the render settings`.

### Task 2: Slow light maths

**Files:**
- Create: `apps/web/src/renderer/slow-light-math.ts`
- Test: `apps/web/src/renderer/slow-light-math.test.ts`

**Interfaces:**
- Produces:
  - `MAX_BETA = 0.5`, `SOURCE_FOV = (130 * Math.PI) / 180`, `SOURCE_WIDTH_FACTOR = 2`.
  - `betaOf(speedTilesPerS: number, lightSpeed: number): number` — clamped to [0, MAX_BETA].
  - `sourceAngle(apparent: number, motion: number, beta: number): number` — radians from facing; `apparent` is the
    column's angle from facing, `motion` the velocity's angle from facing (both positive to the right, the camera
    plane's side).
  - `dopplerFactor(apparent: number, motion: number, beta: number): number` — D = γ(1 + β cos θ'), θ' = apparent − motion.
  - `tintOf(d: number, out: Rgb): Rgb` with `interface Rgb { r: number; g: number; b: number }` — per-channel
    multipliers; identity at d = 1.

`sourceAngle`, the inverse aberration (where the light seen at θ' came from, in the rest frame):

```ts
const t = wrapPi(apparent - motion);          // θ', in (−π, π]
const c = Math.cos(t);
const theta = Math.sign(t) * Math.acos(clamp((c - beta) / (1 - beta * c), -1, 1));
return wrapPi(theta + motion);
```

`tintOf`: let `s = Math.log(d)`; brightness `d ** SEARCHLIGHT_POWER` (start 2); blue gain for s > 0 and red gain
for s < 0, strength `TINT_PER_LOG` × |s| (start 0.8), the other channels eased down by half of it; every multiplier
clamped to [`MIN_GAIN` 0.35, `MAX_GAIN` 1.8]. Named constants, starting points for tuning by play.

- [ ] **Step 1: Write the failing tests:**
  - `beta clamps at half the speed of light`: `betaOf(6, 6) === 0.5`, `betaOf(3, 12) === 0.25`, `betaOf(0, 12) === 0`.
  - `at rest the source angle is the apparent one`: for angles −1..1 rad, `sourceAngle(a, m, 0)` ≈ `a`.
  - `moving forward crowds the view`: `|sourceAngle(0.5, 0, 0.5)| > 0.5`; and straight ahead stays `0`.
  - `aberration is symmetric about the motion`: `sourceAngle(m + x, m, b) - m` ≈ `-(sourceAngle(m - x, m, b) - m)`.
  - `stays finite at the cap in every direction`: for motion 0..2π step 1°, apparent ±33° and ±25°, the result is
    finite and its |value| ≤ `SOURCE_FOV / 2` (Review Focus 3, 5).
  - `doppler is one at rest, above one ahead, below behind`: D(0,0,0)=1; D(0,0,0.5) ≈ γ·1.5 ≈ 1.732;
    D(π,0,0.5) ≈ 0.577.
  - `tint is the identity at d = 1, blue ahead, red behind, clamped`: `tintOf(1)` = {1,1,1}; `tintOf(1.7)` has
    `b > r`; `tintOf(0.58)` has `r > b`; `tintOf(100)` and `tintOf(0.01)` keep every channel within [0.35, 1.8].
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/slow-light-math.test.ts` — FAIL.
- [ ] **Step 3: Implement** as above (pure, no allocation; `tintOf` fills `out`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `Add the aberration, Doppler and tint maths for slow light`.

### Task 3: The local player's own motion

**Files:**
- Create: `apps/web/src/game/own-motion.ts`
- Test: `apps/web/src/game/own-motion.test.ts`

**Interfaces:**
- Consumes: `betaOf` (Task 2), `JUMP_TILES` (`@zoom3d/shared`).
- Produces: `interface Motion { beta: number; angle: number }` (`angle`: velocity from the eye's facing, radians,
  right positive); `createOwnMotion(): OwnMotion` with
  `update(x: number, y: number, eyeAngle: number, dtS: number, lightSpeed: number): Motion` (returns one pooled
  object) and `reset(): void`.

Velocity is the step over `dtS`, smoothed exponentially with time constant `SMOOTHING_S = 0.1`. A step longer than
`JUMP_TILES` is a portal crossing: keep the previous velocity, don't read the step. `dtS <= 0` changes nothing.

- [ ] **Step 1: Write the failing tests:**
  - `standing still has no motion`: same point for 30 frames → `beta === 0`.
  - `walking forward at 3 tiles/s settles at a quarter of c`: 60 frames of dt 1/60 moving 0.05 along the eye's
    facing, c = 12 → `beta` ≈ 0.25 (±0.01), `angle` ≈ 0.
  - `strafing right reads as motion to the right`: moving along facing + π/2 → `angle` ≈ π/2.
  - `turning the head turns the motion, not the speed`: same steps, `eyeAngle` + 0.5 → `angle` ≈ −0.5, beta unchanged.
  - `a step through a portal is no speed`: walk, then one step of 20 tiles → beta stays ≈ 0.25 (Review Focus 1).
  - `riding at 6 tiles/s with c at 6 clamps at half` → `beta === 0.5`, finite (Review Focus 5).
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/game/own-motion.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `Measure the local player's own motion for slow light`.

### Task 4: The bend: source frame, column tables and resample

**Files:**
- Create: `apps/web/src/renderer/slow-light.ts`
- Test: `apps/web/src/renderer/slow-light.test.ts`

**Interfaces:**
- Consumes: Task 2 (`sourceAngle`, `dopplerFactor`, `tintOf`, `SOURCE_FOV`, `SOURCE_WIDTH_FACTOR`), `Motion`
  (Task 3), `createFramebuffer`, `Framebuffer`.
- Produces: `createBend(): Bend` with
  - `fit(output: Framebuffer): Framebuffer` — the source frame (`output.width * SOURCE_WIDTH_FACTOR`,
    `output.height`, `SOURCE_FOV`); the same object until the output's size or FOV changes. Resizes the tables.
  - `aim(output: Framebuffer, motion: Motion): void` — fills per output column: `sourceCol: Int32Array`,
    `rowScale: Float64Array` (k), `gainR/gainG/gainB: Float32Array`. Skips refilling when `motion` and the output are
    unchanged since the last call.
  - `apply(source: Framebuffer, output: Framebuffer): void` — every output pixel (col, y) reads source
    (`sourceCol[col]`, `half + (y − half) / k`, nearest, clamped to the frame) and scales R, G, B by the gains
    (clamp each channel at 255); copies `zbuffer` of the chosen column too.
  - `toOutputX(sourceX: number): number` and `scaleAt(outputX: number): number` — for labels: the output x a source
    x lands at (inverse of `sourceCol`, by binary search over the monotonic table), and that column's k.

Per output column `col`: `α' = atan((col + 0.5 − halfW_o) / proj_o)`; `α = sourceAngle(α', motion.angle,
motion.beta)`; `sourceCol = round(halfW_s + tan(α) · proj_s − 0.5)`, clamped to [0, W_s − 1];
`k = (proj_o / cos α') / (proj_s / cos α)`; gains from `tintOf(dopplerFactor(α', motion.angle, motion.beta))`.
`proj = width / 2 / tan(fov / 2)` as in `setView`.

- [ ] **Step 1: Write the failing tests:**
  - `fit keeps one source frame until the output changes`: two `fit` calls → same object; width 1280, height 360,
    fov `SOURCE_FOV`; a 50° output → a new object (Review Focus 4).
  - `at rest the tables only widen the view`: β = 0 → gains all 1, `sourceCol` monotonic increasing, the middle
    column maps to the source's middle (±1), `rowScale` at the middle ≈ proj_o / proj_s.
  - `moving forward reads the edges from further out`: β = 0.5, angle 0 → the last column's `sourceCol` is beyond
    where β = 0 put it.
  - `tables stay inside the source frame at the cap`: for motion angles every 15°, outputs at `FOV_WIDE` and
    `FOV_TALL` → every `sourceCol` in [0, W_s − 1] (Review Focus 3).
  - `apply copies a flat source unchanged at rest`: a source filled with one colour, β = 0 → every output pixel equals it.
  - `apply tints ahead blue and behind red`: grey source, β = 0.5, motion angle 0 → centre pixel has b > r; motion
    angle π → centre has r > b.
  - `toOutputX inverts sourceCol`: for several columns, `toOutputX(sourceCol[c])` ≈ c (±1).
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/slow-light.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `Bend the finished frame by the own motion for slow light`.

### Task 5: Seen time for light delay, and longer history

**Files:**
- Create: `apps/web/src/game/light-delay.ts`
- Modify: `apps/web/src/net/session.ts:171,187` (buffer capacity)
- Test: `apps/web/src/game/light-delay.test.ts`, `packages/shared/src/net/interpolation.test.ts`

**Interfaces:**
- Consumes: `SnapshotBuffer`, `apparentPosition`, `Apparent`, `Portals`, `GameMap` (`@zoom3d/shared`).
- Produces:
  - `interface SeenLight { map: GameMap; portals: Portals | null; eye: Point; lightSpeed: number }`.
  - `seenAt(buffer: Pick<SnapshotBuffer, 'sample'>, light: SeenLight, drawnAt: number, out: PlayerState): boolean` —
    samples `out` at the time the light reaching the eye now left it, starting from `drawnAt` (today's drawn time);
    false when the buffer is empty.
  - `HISTORY_CAPACITY = 128` (in `light-delay.ts`, imported by `session.ts`).

`seenAt`: `t = drawnAt`; `LIGHT_STEPS = 3` times: sample at `t`, `apparentPosition(map, portals, eye, out, image, 1)`,
`d = hypot(image − eye)`, `t = drawnAt − (d / lightSpeed) * 1000`; finish by sampling at `t`. Pooled `Apparent`.

- [ ] **Step 1: Write the failing tests:**
  - `a still thing is seen d / c ago`: buffer of a still pose 12 tiles away, c 12 → `out` is that pose; and with a
    moving buffer (1 tile/s along x, at 12 tiles away), the result is the pose ≈ 1000 ms before `drawnAt` (±30 ms).
  - `an approaching thing is seen from nearer the true delay than a still one`: compare the solved time for a thing
    walking at 3 tiles/s toward the eye vs away; the receding one is seen longer ago.
  - `faster than light stays finite`: a buffer moving at 30 tiles/s, c 6 → returns true and `out` finite.
  - `through a portal the delay follows the image`: with `test-portals` fixtures (`renderer/test-portals.ts`), a
    thing behind a portal pair is delayed by its image distance, not its straight distance.
  - `empty buffer is not seen` → false.
  - In `interpolation.test.ts`: `sample before the oldest holds the oldest` (Review Focus 2) — push t=1000, t=1066;
    `sample(0)` → the t=1000 pose.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/game/light-delay.test.ts` and
  `pnpm --filter @zoom3d/shared exec vitest run src/net/interpolation.test.ts` — the new ones FAIL (the
  interpolation one may already pass: then it pins today's behaviour).
- [ ] **Step 3: Implement** `seenAt`; in `session.ts` create both buffers with `new SnapshotBuffer(HISTORY_CAPACITY)`.
- [ ] **Step 4: Run** both — PASS; `pnpm bench:sprites` hash unchanged.
- [ ] **Step 5: Commit** — `Solve when the light seen now left a thing, and keep longer pose history`.

### Task 6: Delay remote things in the remote world

**Files:**
- Modify: `apps/web/src/game/remote-world.ts` (`sample`, `sampleObjects`, `samplePeers`)
- Test: `apps/web/src/game/remote-world.test.ts`

**Interfaces:**
- Consumes: `seenAt`, `SeenLight`, `HISTORY_CAPACITY` (Task 5).
- Produces: `RemoteWorld.sample(session, player, now, ball?, portals?, light?: SeenLight | null)` — with `light`,
  every peer and object other than the ball is sampled through `seenAt` from today's drawn time; the ball, unless the
  local player holds it (`ball.heldBy === session.selfId()`), is pushed each sample into a world-owned
  `SnapshotBuffer(HISTORY_CAPACITY)` at `now` (with its shake and lift applied as today after sampling) and sampled
  through `seenAt` from `now`. Without `light` (null or omitted) nothing differs from today.

- [ ] **Step 1: Write the failing tests** (following the file's session fakes):
  - `without slow light a peer is drawn as today` (existing tests keep passing unchanged).
  - `with slow light a far still peer is drawn where it stood`: a peer that moved from (2,2) to (14,2) one second ago
    and has stood since, eye at (2,2), c 12 → drawn at about its pose ≈ 1 s before today's drawn time.
  - `with slow light the vacuum is drawn late too`.
  - `the ball the local player dribbles stays in the present`.
  - `the ball rolling away is drawn late`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/game/remote-world.test.ts` — new ones FAIL.
- [ ] **Step 3: Implement** — one pooled `PlayerState` for `seenAt`'s output; `holdBefore` keeps using `now`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `Draw remote people and objects where their light left them`.

### Task 7: Wire the look into the frame, HUD and room loop

**Files:**
- Modify: `apps/web/src/renderer/frame.ts` (`renderView`, `renderHud`), `apps/web/src/renderer/labels.ts`
  (`drawLabels`), `apps/web/src/game/apparent-world.ts` (`placeOwnLabel`), `apps/web/src/game/room-loop.ts`,
  `apps/web/src/game/game.ts`, `apps/web/bench/walls.ts`
- Test: `apps/web/src/renderer/frame.test.ts`, `apps/web/src/game/apparent-world.test.ts`

**Interfaces:**
- Consumes: `Bend` (Task 4), `OwnMotion`/`Motion` (Task 3), `SeenLight`/`seenAt`/`HISTORY_CAPACITY` (Task 5),
  `RemoteWorld.sample(..., light)` (Task 6), `RenderSettings.light/lightSpeed` (Task 1).
- Produces:
  - `renderView(fb, scene, seen?, bend?: Bend | null)`: with a bend, `const source = bend.fit(fb)`, windows fit to
    `source`, `drawPass(source, …)`, `bend.apply(source, fb)`, then `drawFirstPerson(fb, …)`. Without, as today.
  - `renderHud(hud, fb, scene, showMap, bend?: Bend | null)` → `drawLabels(hud, fb, eye, labels, bend)`: with a bend,
    project through `setView` on `bend.fit(fb)`, then x via `toOutputX` and size via `scaleAt`.
  - `placeOwnLabel(map, portals, eye, label, spot: Point = eye)`.
  - `RoomLoopOptions.slowLight(): number | null` — c in tiles/s while the look is on, else null; `game.ts` passes
    `() => renderSettings.light === 'slow' ? renderSettings.lightSpeed : null`.

In `room-loop.ts`: one `createBend()`, one `createOwnMotion()`, one `SeenLight` (pooled, refilled each frame), one
own-pose `SnapshotBuffer(HISTORY_CAPACITY)`. Each frame with `slowLight()` non-null: `ownMotion.update(pose.x,
pose.y, eye.angle, dt, c)`, `bend.aim(screen.fb, motion)`, push the own pose at `now`, pass the `SeenLight` to
`world.sample` (also from `whileHidden`, so sounds don't jump on return), and when `scene.self` is set, sample the
own buffer through `seenAt` using the image distance (`imagePosition`, as `placeOwnLabel`) and move `scene.self`,
`scene.ownScooter` and the own label's spot to it. With the look off: `ownMotion.reset()`, pass `null` everywhere.

- [ ] **Step 1: Write the failing tests:**
  - `frame.test.ts`: `renderView without a bend draws as before` (existing pass); `renderView with a bend at rest
    keeps first-person items unbent`: with a scene holding `firstPerson`, the bottom rows where the held item is drawn
    match a bend-less render's rows (draw both and compare those rows).
  - `apparent-world.test.ts`: `placeOwnLabel places the own label at a given spot's image`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/frame.test.ts src/game/apparent-world.test.ts` — FAIL.
- [ ] **Step 3: Implement** the interfaces and the room-loop wiring above.
- [ ] **Step 4: Add a bench case** to `apps/web/bench/walls.ts`: the lit room drawn into a `SOURCE_WIDTH_FACTOR`×
  `SOURCE_FOV` frame plus `bend.apply` at β 0.5, reported beside today's case (no hash for it).
- [ ] **Step 5: Run** `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm bench:walls`, `pnpm bench:sprites` — all
  pass, existing hashes unchanged; note the slow-light frame time.
- [ ] **Step 6: Verify in the game** — `preview_start` the dev server, join a room with `?bots=20`, open the console
  (backtick), set Light: Slow; walk and ride: screenshot at rest and at speed, confirm no console errors and labels
  sit over discs.
- [ ] **Step 7: Commit** — `Draw the room through slow light when the console asks for it`.

### Task 8: Record the decision

**Files:**
- Modify: `docs/open-decisions.md` (add D39 under the D38 entry, with date 2026-11-22), `AGENTS.md` (Gotchas),
  `docs/superpowers/specs/2026-11-22-slow-light-design.md` (status: built)

- [ ] **Step 1: Write D39**: a per-person look; post-process bend (approach A, owner's pick) over per-pass rays; 2×
  130° source, soft is fine (owner); β cap 0.5; one delay per thing; sounds from where things are seen; faces and
  voices live.
- [ ] **Step 2: Add an AGENTS.md gotcha**, short: slow light (D39) is a per-person look; `renderView` draws into the
  bend's source frame and resamples, so anything new drawn in the room goes through `drawPass` and anything held
  in first person after `bend.apply`; light delay goes through `seenAt` in `RemoteWorld.sample`; the look off must
  stay pixel-identical.
- [ ] **Step 3: Run** `pnpm lint`.
- [ ] **Step 4: Commit** — `Record D39: slow light`.
