# Landing-page Vacuum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After 10 s on `/`, the room's robot vacuum drives out of hiding, cleans the landing corridor (bumping Ada,
Bob, Max and the camera), then searches for its dock forever. It ignores all input and resets on "Start a party".

**Architecture:** The pure vacuum sim moves from `apps/server` into `packages/shared` so the browser runs the same
copy. A pure `landing-show.ts` owns show time, the 10 s wait, a fixed-seed sim stepped at the fan-out tick, and an
interpolated pose. `renderLandingScene` learns to draw a vacuum without per-frame allocations, and `main.ts` runs a
small landing loop (not the room loop) until Start a party.

**Tech Stack:** TypeScript, Vite, Vitest, Playwright, Biome; pnpm workspace (Node ≥ 22).

**Spec:** [docs/superpowers/specs/2026-10-13-landing-vacuum-design.md](../specs/2026-10-13-landing-vacuum-design.md)

## Global Constraints

- The room vacuum's behaviour doesn't change: every existing server vacuum test passes, with only its imports changed.
- Before 10 s of show time the landing frame is pixel-identical to today's still, and the vacuum is in view of
  neither camera.
- Nothing on the landing page reacts to the visitor: no listeners feed the show, and the camera is fixed.
- No sound and no `AudioContext` on the landing page.
- The show is the same for everyone: fixed parking pose, fixed seed, fixed step of `FANOUT_TICK_MS` (66 ms).
- Show time advances only on rendered frames. Each frame's dt is clamped, so a background tab pauses the show.
- `prefers-reduced-motion: reduce` at load → today's still, no show. Read it once, like `TOUCH`.
- No allocations in the per-frame path (AGENTS.md).
- Code style: Biome (`npx biome check --write .`); braced blocks; names with units (`docs/code-style.md`); `.at()`
  over `arr[i] as T`.
- Shell note: this machine's default `node` is v11. Prefix commands with
  `export PATH=~/.nvm/versions/node/v22.23.3/bin:$PATH &&`.
- Branch: create `feat/landing-vacuum` from the current `refactor/vacuum-readability` HEAD (its vacuum refactor isn't
  on `main` yet).

## Review Focus

1. **A tab left in the background for minutes:** on return, the show resumes where it was. It must not jump ahead,
   and it must not run thousands of steps in one frame. (Task 2: `advance` clamp test.)
2. **Resize or rotation while the show runs:** `rebuildFrame` redraws the still. The next frame must draw the vacuum
   again, and a portrait rotation must switch cameras without restarting the show. (Task 4: manual check.)
3. **Start a party at any moment (before 10 s, mid-clean or lost):** the loop stops, and the lobby picture has no
   vacuum and never changes. (Task 4: e2e.)
4. **The vacuum at close range:** with the camera as a person, the vacuum never comes close enough for its faces to
   clip at `MIN_DEPTH`. (Task 2: minimum-distance test.)
5. **Clicks, keys and pointer movement on `/`:** they don't change the show. The canvas's existing pointerdown and
   pointer-lock handlers must stay inert outside a room. (Task 4: an e2e clicks and types, and the vacuum stays
   parked with no pointer lock.)

---

### Task 1: Move the vacuum sim into `packages/shared`

**Files:**
- Move (`git mv`): `apps/server/src/objects/vacuum/{vacuum,nav,vacuum.test,nav.test,test-helpers}.ts` →
  `packages/shared/src/objects/vacuum/`
- Create: `packages/shared/src/random.ts` (`pick`, moved from `apps/server/src/random.ts`, plus `seeded`, moved from
  `test-helpers.ts`)
- Delete: `apps/server/src/random.ts`
- Modify: `packages/shared/src/index.ts`; `apps/server/src/lobby.ts:30-39`, `apps/server/src/snapshot.ts:6`,
  `apps/server/src/bots.ts:5`, `apps/server/src/objects/vacuum/vacuum-lobby.test.ts` (stays in the server; import
  from `@zoom3d/shared`); any other importer of `../random` or `./random`
- Docs: `docs/open-decisions.md` D22, `AGENTS.md` (world-objects gotcha path), and commit the spec and this plan

**Interfaces:**
- Produces, from `@zoom3d/shared`: everything `vacuum.ts` and `nav.ts` exported before (`createVacuum`,
  `stepVacuum`, `saveVacuum`, `restoreVacuum`, `vacuumInfo`, `Vacuum`, `VacuumSave`, `VacuumPhase`, `VACUUM_SPEED`,
  `VACUUM_TURN_SPEED`, `createVacuumNav`, `VacuumNav`, `VACUUM_RADIUS`, `mapFingerprint`, `Point`), plus
  `pick<T>(rng: () => number, items: readonly T[]): T | undefined` and `seeded(seed?: number): () => number`.
- Inside `packages/shared`, the moved files import from relative paths (`../../geometry/movement`,
  `../../protocol/protocol`, `../../random`, and so on), not from `@zoom3d/shared`.

- [ ] **Step 1: Branch and commit the design docs**

```bash
git switch -c feat/landing-vacuum
git add docs/superpowers/specs/2026-10-13-landing-vacuum-design.md docs/superpowers/plans/2026-10-13-landing-vacuum.md
git commit -m "Design the landing-page vacuum"
```

- [ ] **Step 2: Move the files and fix the imports**

Use `git mv` for the five files. `test-helpers.ts` keeps `defined`, and its `seeded` becomes a re-export of
`seeded` from `../../random` (or the tests import it from there directly). Add `export * from './objects/vacuum/nav';`,
`export * from './objects/vacuum/vacuum';` and `export * from './random';` to `index.ts`. If an export name clashes
with an existing one (check `Point`), fix it in this step.

- [ ] **Step 3: Verify nothing changed behaviour**

Run: `npx vitest run && npx tsc -p packages/shared && npx tsc -p apps/web && npx tsc -p apps/server && npx biome check .`
Expected: all tests pass, with the same count as before the move (record the count before Step 2). No type or lint
errors.

- [ ] **Step 4: Update the docs**

- D22 gets an *Amended 2026-10-13* line: the sim lives in `packages/shared/src/objects/vacuum/`, and the landing
  page runs it in the browser (link the spec).
- The world-objects bullet in `AGENTS.md` points at the new path.

- [ ] **Step 5: Commit**

```bash
git add -A packages/shared apps/server docs/open-decisions.md AGENTS.md
git commit -m "Move the robot vacuum sim into the shared package"
```

---

### Task 2: The landing show (pure)

**Files:**
- Modify: `packages/shared/src/objects/vacuum/vacuum.ts` (add `parkVacuum`)
- Test: `packages/shared/src/objects/vacuum/vacuum.test.ts`
- Create: `apps/web/src/ui/landing-show.ts`
- Test: `apps/web/src/ui/landing-show.test.ts`

**Interfaces:**
- Consumes (Task 1): `createVacuumNav`, `stepVacuum`, `Vacuum`, `seeded`, `PLAYER_RADIUS`, `VACUUM_RADIUS`,
  `SnapshotBuffer`, and `FANOUT_TICK_MS` from `@zoom3d/shared`; `LANDING_MAP`, `LANDING_PEOPLE` and `LANDING_CAMERA`
  from `./landing-scene`.
- Produces:
  - `parkVacuum(id: string, x: number, y: number, angle: number): Vacuum`: a `cleaning` robot with nothing clean, at
    that pose (angle normalised). It is a thin export over `initialState`.
  - In `landing-show.ts`:
    - `LANDING_SHOW_WAIT_S = 10`
    - `LANDING_PARK: Readonly<PlayerState> = { x: 1.5, y: 3.5, angle: 0 }`. This is the corridor's north-west
      corner, measured invisible from both cameras at every heading and 1.33 tiles from the camera. No map nook is
      needed.
    - `MAX_FRAME_S = 0.25`
    - `LANDING_SHOW_SEED = 7` (any fixed value; the tests pin determinism, not the particular run)
    - `createLandingShow(): LandingShow`

```ts
export interface LandingShow {
  /** Seconds of show time so far. */
  readonly timeS: number;
  /** The simulated robot; read it, don't change it. */
  readonly vacuum: Readonly<Vacuum>;
  /** Bumps so far (stepVacuum returned 'bump'). */
  readonly bumps: number;
  /** Adds one frame's time, clamped to MAX_FRAME_S, then runs any whole FANOUT_TICK_MS steps due after the wait. */
  advance(frameS: number): void;
  /** Writes the pose to draw now: LANDING_PARK before the wait ends, else interpolated between the last two steps. */
  poseInto(out: { x: number; y: number; angle: number }): void;
}
```

Approach: the sim's `people` is a fixed array of `LANDING_PEOPLE` positions plus `LANDING_CAMERA`'s `{x, y}` (spec
§2.3). The rng is `seeded(LANDING_SHOW_SEED)`. Push each step's pose to a small `SnapshotBuffer` at its step time,
and sample it one step behind the show time, as the room does for objects. No allocations in `advance` or
`poseInto` beyond what `SnapshotBuffer.push` already does.

- [ ] **Step 1: Write the failing tests**

In `vacuum.test.ts`:
- `test('a parked robot starts cleaning from the given pose')`: `parkVacuum('v', 1.5, 3.5, -Math.PI / 2)` has
  phase `'cleaning'`, `clean.size === 0`, x 1.5, y 3.5 and angle `3 * Math.PI / 2`. After stepping 60 s on the test's
  open room, it has moved and cleaned at least one patch.

In `landing-show.test.ts` (step with `advance(1 / 60)` in a loop through a helper `runUntil(show, seconds)`):
- `'the vacuum stays parked for the first 10 s'`: at 9.9 s the pose equals `LANDING_PARK`, and `vacuum.x/y` are
  unchanged.
- `'it drives off after the wait'`: by 15 s the pose is more than 0.1 tiles from `LANDING_PARK`.
- `'a long frame counts as at most MAX_FRAME_S'`: after `advance(300)`, `timeS === MAX_FRAME_S`.
- `'it bumps into the people while cleaning'`: run until the phase is `'searching'` (cap at 900 s). At that point
  `bumps ≥ 1`.
- `'it finishes cleaning and gets lost'`: phase `'searching'` before 900 s, and still `'searching'` 120 s later.
- `'every show is the same show'`: two shows sampled at 30, 120 and 400 s give equal poses (`toEqual`).
- `'the camera is a person: the vacuum keeps its distance'`: over a full run to 900 s, every pose's distance to
  `LANDING_CAMERA` is greater than 0.45 tiles. That keeps its faces clear of `MIN_DEPTH`; a trial run measured 0.56.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/shared/src/objects/vacuum/vacuum.test.ts apps/web/src/ui/landing-show.test.ts`
Expected: FAIL. `parkVacuum` isn't exported, and `./landing-show` can't be found.

- [ ] **Step 3: Implement `parkVacuum` and `landing-show.ts`**

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command. Expected: PASS. If the full run takes longer than about 5 s, run it once in a `beforeAll`
shared by the run-to-the-end tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/objects/vacuum apps/web/src/ui/landing-show.ts apps/web/src/ui/landing-show.test.ts
git commit -m "Script the landing show: park, wait 10 s, clean, get lost"
```

---

### Task 3: Draw the vacuum in the landing scene

**Files:**
- Modify: `apps/web/src/ui/landing-scene.ts` (`renderLandingScene`)
- Test: `apps/web/src/ui/landing-scene.test.ts`

**Interfaces:**
- Consumes: `VACUUM_MODEL` (`renderer/models/vacuum`), `VoxelInstance` (`renderer/voxels`); `LANDING_PARK` from
  Task 2 (tests only).
- Produces:
  `renderLandingScene(fb: Framebuffer, opts?: { logo?: boolean; lights?: boolean; vacuum?: VoxelInstance | null }): void`.
  It draws the vacuum, lit with the landing lighting when `lights`, through `renderSprites(fb, camera, sprites,
  undefined, vacuum ? [vacuum] : [], lighting)`. The textures, the three `Sprite`s (with their face texels) and the
  one-element voxel array are built once and reused. Today each call rebuilds them, which a per-frame caller can't
  afford.

- [ ] **Step 1: Write the failing tests**

- `'the parked vacuum is out of sight of both cameras'`: for the landscape frame (`createFramebuffer()`) and the
  portrait one (`createFramebuffer(296, 640, fovForAspect(296 / 640))`), with `lights` both on and off, a frame with
  `vacuum: { model: VACUUM_MODEL, ...LANDING_PARK }` has `pixels` equal to the frame without it.
- `'a vacuum in the corridor is drawn'`: `vacuum` at `{ x: 6, y: 4.5, angle: 0 }` changes at least 100 pixels of
  the landscape frame.
- `'repeated frames draw the same picture'`: two calls on the same framebuffer give identical pixels. This guards the
  cached sprites.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/src/ui/landing-scene.test.ts`
Expected: the corridor-vacuum test fails (`vacuum` is ignored); the others may already pass.

- [ ] **Step 3: Implement the `vacuum` option and the one-time caches**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/web/src/ui/landing-scene.test.ts`
Expected: PASS, the existing staging tests included.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/landing-scene.ts apps/web/src/ui/landing-scene.test.ts
git commit -m "Let the landing scene draw the vacuum, building its sprites once"
```

---

### Task 4: Run the show on `/`, stop it on Start a party

**Files:**
- Modify: `apps/web/src/main.ts` (landing branch near line 523; `showStill` and `startFrames` near line 846;
  `rebuildFrame` near line 166)
- Create: `apps/web/e2e/landing.spec.ts`
- Docs: `docs/open-decisions.md` D19; set the spec's Status to "implemented 2026-10-13"

**Interfaces:**
- Consumes: `createLandingShow`, `LandingShow` (Task 2); `renderLandingScene(fb, { logo, lights, vacuum })`
  (Task 3); `startLoop(tick): () => void` (`game/loop.ts`).

Approach:
- `const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;` sits next to `TOUCH`.
- On the landing route, unless `REDUCED_MOTION`, `startLandingShow()` creates the show and one reused
  `VoxelInstance`, and calls `startLoop`. Each frame does `show.advance(dt)`, `show.poseInto(vacuum)`, draws with
  `{ logo: true, lights: LIGHTS, vacuum }` and calls `putImageData`. It keeps the stop function.
- `showStill` passes the current landing vacuum (or `null`), so a `rebuildFrame` during the show doesn't flash a
  frame without it.
- The Start a party handler calls the stop function, sets the vacuum to `null`, then calls `showStill(false)`, as
  today.
- `looping` (the room loop) stays false on `/`.
- No input listener reads or writes the show.

- [ ] **Step 1: Write the failing e2e**

`apps/web/e2e/landing.spec.ts`, with `test.setTimeout(60_000)`. Snapshot the canvas with
`page.locator('#game').screenshot()` and compare `Buffer`s:
- `'the vacuum comes out after 10 seconds'`: the shots at about 1 s and about 9 s are equal (still parked), and the
  shot at about 14 s differs from the 9 s one.
- `'input does not wake the vacuum early'`: during the first 5 s, click the canvas, move the mouse across it and
  press `w`, `ArrowLeft` and `Space`. The 9 s shot still equals the 1 s shot, and
  `document.pointerLockElement === null`. Determinism under input is guaranteed by construction (no listener reaches
  the show) and by Task 2's same-show test. Comparing two pages pixel for pixel would be flaky on frame timing.
- `'Start a party resets to a still lobby picture'`: wait about 14 s, click Start a party, and the two canvas shots
  taken 2 s apart are equal.
- `'reduced motion keeps the still picture'`: with `page.emulateMedia({ reducedMotion: 'reduce' })` set before
  `goto`, the shots at about 1 s and about 14 s are equal.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm e2e -- landing.spec.ts`
Expected: "comes out after 10 seconds" fails (the canvas never changes). The others may pass.

- [ ] **Step 3: Implement the landing loop in `main.ts`**

- [ ] **Step 4: Run the e2e and the whole suite**

Run: `pnpm e2e -- landing.spec.ts && npx vitest run && npx tsc -p apps/web && npx biome check .`
Expected: all pass.

- [ ] **Step 5: Check it by eye**

Start the `dev` preview and open `/`:
- At 0–10 s it looks exactly as today, with no console errors.
- After 10 s the vacuum appears from the left.
- Resize the window mid-show: it keeps going.
- In the mobile preset, reload: the portrait camera shows the show.
- Background the tab for 30 s: it resumes where it was.
- Click Start a party: the lobby picture is still.

Screenshot the vacuum mid-corridor for the PR.

- [ ] **Step 6: Update the docs**

D19 gets an *Amended 2026-10-13* line. The landing frame animates the robot vacuum: parked out of view, it comes out
after 10 s, cleans, bumps Ada, Bob, Max and the camera, then searches forever. There is no input, no sound and the
same show for everyone. It stops on Start a party, and stays still under reduced motion. The room loop still never
starts on `/`. Link the spec.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/main.ts apps/web/e2e/landing.spec.ts docs/open-decisions.md docs/superpowers/specs/2026-10-13-landing-vacuum-design.md
git commit -m "Bring the landing picture to life with the robot vacuum"
```
