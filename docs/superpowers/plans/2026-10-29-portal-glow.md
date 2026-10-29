# Portal Glow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With portals on, each portal window shimmers pink with a glowing rim, pink light pulses on the floor, walls
and ceiling in front of it, and each portal hums softly through the room's spatial audio.

**Architecture:**
- **The pulse.** One pure pulse function and one pink colour, in `game/portal-pulse.ts`, drive everything. The room
  loop works out `pulse` and `t` once per frame and puts them on the scene.
- **The spill.** It is avatar glow with an optional `cut` plane (`renderer/glow.ts`), so it lights only the doorway's
  front side. `renderView` appends one portal glow per doorway.
- **The window.** Its effects are applied as `copyWindowRows` (`renderer/frame.ts`) copies a window's rows.
- **The hum.** It is a synthesised node per doorway, attached through `AudioEngine.attachNode` like the vacuum. Its
  position goes through `placeApparently`, so it follows every spatial rule, and its swell is set from the same pulse
  every frame.

**Tech Stack:** TypeScript, Vitest, Web Audio, Biome, esbuild benches.

**Spec:** `docs/superpowers/specs/2026-10-29-portal-glow-design.md` (builds on D27 and D28)

## Global Constraints

- **Portals off changes nothing.** These hashes must hold:
  - `pnpm bench:walls`: pixel `-601092469`, portals-off doorway `-1246551896`, crowd off `2075427884`;
  - `pnpm bench:sprites`: `1236007431`, portals-off doorway scenes `-1373330069`.
- **The pulse:** `pulse = 1 − depth · (0.5 − 0.5 · sin(2π · rate · t))`, with `rate = 0.8` Hz and `depth = 0.4`. It
  runs on each player's own clock and is never sent over the wire.
- **Pink:** linear `{ r: 1.0, g: 0.42, b: 0.78 }`. One colour for every portal.
- **Shimmer:** `k = 0.16 + 0.2·pulse + 0.1·ripple`, with `ripple = 0.5 + 0.5·sin(row·0.32 + col·0.06 − t·5.5)`, and
  `pixel·(1−k) + pink·0.9·k`. Rows and columns are counted in 320-wide units: multiply by `320 / frameWidth`.
- **Rim:** add `pink · exp(−edge / 2.2) · (0.35 + 0.65·pulse)`, where `edge` is the distance to the nearest edge of
  the opening, in 320-wide pixels.
- **Spill:**
  - one glow per portal at `c − 0.6·n`, at avatar glow height;
  - lights a point only where `(point − c)·n < 0`;
  - colour pink × `PORTAL_GLOW_STRENGTH` × `(0.25 + 0.75·pulse)`;
  - reach `GLOW_RADIUS`;
  - lights floor, walls and ceiling, but never people or objects.
- **Hum:**
  - 98 Hz sine at 0.2 and a 147 Hz triangle at 0.25, through a low-pass at 1500 Hz with Q 4;
  - its swell gain is `pulse`;
  - its source sits at `c − 0.3·n`;
  - it stays under voices, like `VACUUM_GAIN`;
  - it fades in and out over about 0.3 s, with no clicks.
- **No allocations** in the per-frame or per-column path.
- **Code style:**
  - every `if`/`else`/`for`/`while` body is braced, in Biome style;
  - `.at()` over `arr[i] as T`;
  - names over comments, and comments say only why (docs/code-style.md);
  - no "you/your" in identifiers, comments or test titles;
  - 120 columns.

## Review Focus

1. **Glow used to light only surfaces facing it, and the new cut must not change that for avatar glows.** An avatar
   glow (`cut: null`) must light exactly as before. (Task 2, `a glow without a cut lights as before, on both sides`.)
2. **A point exactly on the plane counts as the back side** (`≥ 0`). That leaves no sliver of pink on the doorway
   line seen from behind. (Task 2, `a point on the plane is not lit`.)
3. **Window edges at a window inside a window.** The rim is measured per level from that level's eye, never from the
   main eye. (Task 3, `the rim is brightest at the opening's edge and fades inward`, run with the eye of a window
   level.)
4. **Portals flipping off with hums playing.** Every hum fades out and is detached, and its oscillators stop. Flipping
   on again starts fresh hums, never doubled ones. (Task 4,
   `turning portals off fades every hum out and detaches it; on again attaches each once`.)
5. **Hidden tab.** The loop's hidden tick still places sounds (`room-loop.ts` `whileHidden`), so the hum's position
   and swell keep updating or hold still, but never jump. (Task 4, checked by reading the hidden tick's path.)

---

### Task 1: The pulse and the pink

**Files:**
- Create: `apps/web/src/game/portal-pulse.ts`
- Test: `apps/web/src/game/portal-pulse.test.ts`

**Interfaces:**
- Produces:
  - `PORTAL_PULSE_HZ = 0.8`;
  - `PORTAL_PULSE_DEPTH = 0.4`;
  - `PORTAL_PINK: { readonly r: number; readonly g: number; readonly b: number }` = `{ r: 1, g: 0.42, b: 0.78 }`;
  - `portalPulse(seconds: number): number`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('swings between 1 − depth and 1', () => {
  const samples = Array.from({ length: 200 }, (_, i) => portalPulse(i / 100));
  expect(Math.min(...samples)).toBeCloseTo(0.6, 2);
  expect(Math.max(...samples)).toBeCloseTo(1, 2);
});
test('repeats 0.8 times a second', () => {
  expect(portalPulse(0.3)).toBeCloseTo(portalPulse(0.3 + 1 / 0.8), 9);
});
test('is at its midpoint at time 0', () => {
  expect(portalPulse(0)).toBeCloseTo(0.8, 9);
});
```

- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/game/portal-pulse.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the constants and `portalPulse`, exactly as the Global Constraints formula gives it.
- [ ] **Step 4: Run** it again (PASS), then `pnpm typecheck`.
- [ ] **Step 5: Commit** `git commit -m "Add the portal pulse and its pink"`

### Task 2: Glow with a cut, and the portal glows

**Files:**
- Modify: `apps/web/src/renderer/glow.ts` (the `Glow` type, `glowLight`, and `createAvatarGlows`, whose pool sets
  `cut: null`)
- Modify: `apps/web/src/renderer/frame.ts` (`renderView` appends the portal glows; `RoomScene` gains `portalPulse`)
- Modify: `apps/web/src/game/room-loop.ts` (`describeScene` sets `scene.portalPulse` from
  `portalPulse(performance.now() / 1000)`)
- Modify: the benches that build a `RoomScene` (`apps/web/bench/walls.ts`, `apps/web/bench/sprites.ts`) and any test
  helper that builds one. They set a fixed `portalPulse` of `1`, so bench hashes are deterministic.
- Test: `apps/web/src/renderer/glow.test.ts`

**Interfaces:**
- Consumes: `PORTAL_PINK` (Task 1).
- Produces:
  - `Glow.cut: GlowCut | null`, where `GlowCut = { cx: number; cy: number; nx: number; ny: number }`. `glowLight`
    returns 0 when `(x − cx)·nx + (y − cy)·ny >= 0`.
  - `PORTAL_GLOW_STRENGTH`, a number in glow.ts. Start at `0.9` and tune it by eye in Task 5.
  - `createPortalGlows(): { update(portals: Portals | null, pulse: number): readonly Glow[] }`. Its glows are pooled and
    allocation-free: one per portal at `(cx − 0.6·nx, cy − 0.6·ny)`, with `cut` = that portal's plane and colour as in
    the Global Constraints.
  - `RoomScene.portalPulse: number`.
  - `renderView` lights the frame with the avatar glows followed by the portal glows, and only when `scene.portals` is
    not null. With portals off, the glow list is exactly today's.

- [ ] **Step 1: Write the failing tests** in `glow.test.ts`:

```ts
const plane = { cx: 2.5, cy: 3.5, nx: 0, ny: 1 }; // front side is y < 3.5
const glow = (cut: GlowCut | null): Glow => ({ x: 2.5, y: 2.9, r: 1, g: 1, b: 1, cut });
test('a glow without a cut lights as before, on both sides', () => {
  expect(glowLight(glow(null), 2.5, 4.0, 0, 0, 0, 1)).toBeGreaterThan(0);
  expect(glowLight(glow(null), 2.5, 2.0, 0, 0, 0, 1)).toBeGreaterThan(0);
});
test('a cut glow lights its front side only', () => {
  expect(glowLight(glow(plane), 2.5, 2.0, 0, 0, 0, 1)).toBeGreaterThan(0);
  expect(glowLight(glow(plane), 2.5, 4.0, 0, 0, 0, 1)).toBe(0);
});
test('a point on the plane is not lit', () => {
  expect(glowLight(glow(plane), 2.5, 3.5, 0, 0, 0, 1)).toBe(0);
});
test('a portal glow stands 0.6 in front of its plane, pink, brighter with the pulse', () => {
  const [g] = createPortalGlows().update(portalHall().portals, 1);
  expect(g).toMatchObject({ x: 2.5, y: 2.9, cut: { cx: 2.5, cy: 3.5, nx: 0, ny: 1 } });
  const dim = createPortalGlows().update(portalHall().portals, 0.6).at(0);
  expect(dim?.r ?? 0).toBeLessThan(g?.r ?? 0);
  expect(g?.g ?? 0).toBeCloseTo((g?.r ?? 0) * 0.42, 9);
});
test('no portals, no portal glows', () => {
  expect(createPortalGlows().update(null, 1)).toHaveLength(0);
});
```

  `portalHall()` is the fixture in `apps/web/src/renderer/test-portals.ts`. Doorway A is at (2, 3) with its front
  north, so `n = (0, 1)`. Test-only `x`/`y` values can sit on the plane exactly, because floating-point gives
  `0 >= 0`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/glow.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the type, the cut test, `createPortalGlows`, `RoomScene.portalPulse`, the `renderView`
  append and the `describeScene` line. Put the cut test first in `glowLight`, before the reach test, and keep
  `glowLight` small.
- [ ] **Step 4: Run** the test file (PASS), then `pnpm test`, `pnpm typecheck` and `pnpm lint`. Then run
  `pnpm bench:walls` and `pnpm bench:sprites`: every portals-off hash equals the Global Constraints values. Portals-on
  hashes change; print them in the report.
- [ ] **Step 5: Commit** `git commit -m "Light the front of each portal doorway with a pulsing pink glow"`

### Task 3: The window's shimmer and rim

**Files:**
- Create: `apps/web/src/renderer/portal-window.ts`
- Modify: `apps/web/src/renderer/frame.ts`:
  - `copyWindowRows` applies the effect to each copied pixel;
  - it takes the portal, the scene's `portalPulse` and a time;
  - `RoomScene` gains `portalTime: number` (seconds), set in `describeScene`, and fixed at `0` in benches and helpers.
- Test: `apps/web/src/renderer/portal-window.test.ts`

**Interfaces:**
- Consumes: `PORTAL_PINK` (Task 1); `Portal` from `@zoom3d/shared`; `View`/`setView` (`renderer/camera.ts`).
- Produces:
  - `shimmerAndRim(pixel: number, pulse: number, ripple: number, edge: number): number`. It takes a packed
    framebuffer colour (`rgb()` layout, see `renderer/framebuffer.ts`) and returns the shimmered colour with the rim
    added, clamped. `edge` is in 320-wide pixels.
  - `windowRipple(row: number, col: number, frameWidth: number, seconds: number): number`, which applies the
    `320 / frameWidth` scaling.
  - `openingEdge(view: View, portal: Portal, col: number, depth: number, frameWidth: number): number`. This is the
    side distance to the opening's nearest edge, in 320-wide pixels.
    - The column's ray meets the plane at `hit = eye + depth · (dir + plane·camX)`, with
      `camX = 2·(col + 0.5)/frameWidth − 1`.
    - `along = (hit − c)·(−ny, nx)`.
    - The result is `(0.5 − |along|) · (proj / depth) · 320 / frameWidth`.
  - The top and bottom distances come from the copied row range (`rowsCovered`), in the same units. `edge` is the
    least of the three.

- [ ] **Step 1: Write the failing tests:**

```ts
test('the rim is brightest at the opening’s edge and fades inward', () => {
  const black = rgb(0, 0, 0);
  const atEdge = shimmerAndRim(black, 1, 0, 0);
  const inside = shimmerAndRim(black, 1, 0, 10);
  expect(red(atEdge)).toBeGreaterThan(red(inside));
});
test('the shimmer pulls a grey pixel toward pink, more at the pulse’s peak', () => {
  const grey = rgb(100, 100, 100);
  const low = shimmerAndRim(grey, 0.6, 0.5, 100);
  const high = shimmerAndRim(grey, 1, 0.5, 100);
  expect(red(high) - green(high)).toBeGreaterThan(red(low) - green(low));
  expect(red(low)).toBeGreaterThan(green(low));
});
test('the ripple is the same wave at any frame width', () => {
  expect(windowRipple(64, 128, 640, 0)).toBeCloseTo(windowRipple(32, 64, 320, 0), 9);
});
test('a column through the middle of the opening is half a tile from either edge', () => {
  // Eye 1.5 tiles in front of doorway A (portalHall), looking straight through its centre.
  const view = setView(createView(), { width: 320, height: 200, fov: FOV }, { x: 2.5, y: 2.0, angle: Math.PI / 2 });
  const edge = openingEdge(view, portalHall().portals.list[0], 159.5, 1.5, 320);
  expect(edge).toBeCloseTo(0.5 * (view.proj / 1.5), 1);
});
```

  `red` and `green` read a packed colour's channels. Write them in the test, or reuse a helper from
  `renderer/test-helpers.ts` if one exists. `FOV` is whatever `Framebuffer` uses by default; read it from
  `framebuffer.ts`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/portal-window.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three functions, then call them from `copyWindowRows`. `copyWindowRows` already sets
  `frameView` to the level's eye, so a window inside a window measures its own edges. The function body must not
  allocate.
- [ ] **Step 4: Run** the test file (PASS), then `pnpm test`, `pnpm typecheck` and `pnpm lint`. Run both benches:
  portals-off hashes unchanged, and the portals-on doorway frame time printed beside Task 2's.
- [ ] **Step 5: Commit** `git commit -m "Shimmer each portal window and light its rim"`

### Task 4: The hum

**Files:**
- Create: `apps/web/src/audio/portal-hum.ts`
- Modify: `apps/web/src/game/room.ts`:
  - `Room` gains `hums: PortalHums`;
  - it is created with the room's `AudioContext` and engine, as `objectSounds` is;
  - it is disposed with the room.
- Modify: `apps/web/src/game/room-loop.ts`:
  - `placeApparently` adds each hum's source point as a thing, with id `portalHumKey(i)` and position `c − 0.3·n`, so
    `apparentWorld` places it through portals;
  - each frame, and on the hidden tick, call `room.hums.sync(room.portals(), pulse)`.
- Test: `apps/web/src/audio/portal-hum.test.ts`

**Interfaces:**
- Consumes: `PORTAL_PULSE_*` and `portalPulse` (Task 1); `AudioEngine.attachNode` and `detach`.
- Produces:
  - `HUM_GAIN`, a master level like `VACUUM_GAIN`. Start at `0.04` and tune it by ear in Task 5.
  - `portalHumKey(index: number): string`, returning `` `portal-hum:${index}` ``.
  - `createPortalHums(ctx: BaseAudioContext, engine: Pick<AudioEngine, 'attachNode' | 'detach'>): PortalHums`, with:
    - `sync(portals: Portals | null, pulse: number): void`;
    - `sourcesOf(portals: Portals | null, out: Map<string, { x: number; y: number }>): void`, or another
      allocation-free way to hand positions to `placeApparently`;
    - `dispose(): void`.
  - Each hum:
    - a 98 Hz sine through a 0.2 gain, plus a 147 Hz triangle through a 0.25 gain;
    - both into a low-pass at 1500 Hz with Q 4;
    - then a swell gain set to `pulse` with `setTargetAtTime(pulse, now, 0.05)`;
    - then an output gain of `HUM_GAIN` that fades over about 0.3 s;
    - attached as `attachNode(portalHumKey(i), output)`.

- [ ] **Step 1: Write the failing tests.** Use a fake `AudioContext` the way the vacuum sound's tests do; read
  `apps/web/src/audio/vacuum-sound.test.ts` for the pattern. Use a fake engine that records attach and detach calls.

```ts
test('portals on attaches one hum per portal, each once', ...);            // sync(portals, 1) twice → 2 attaches for portalHall
test('turning portals off fades every hum out and detaches it; on again attaches each once', ...);
test('the swell follows the pulse', ...);                                   // last setTargetAtTime on each swell gain === pulse
test('a hum sits 0.3 in front of its doorway', ...);                        // sourcesOf: portal-hum:0 at (2.5, 3.2)
```

  Detaching may wait for the fade to end. The test advances the fake context's clock, or asserts that the detach is
  scheduled.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/audio/portal-hum.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `portal-hum.ts` and wire it into `room.ts` and `room-loop.ts`. Check Review Focus 5: read
  `whileHidden` and keep the hums' positions updated there, as object sounds are.
- [ ] **Step 4: Run** the test file (PASS), then `pnpm test`, `pnpm typecheck`, `pnpm lint` and
  `pnpm --filter @zoom3d/web exec playwright test e2e/portals.spec.ts`.
- [ ] **Step 5: Commit** `git commit -m "Hum from each portal doorway while portals are on"`

### Task 5: Tune, measure and record

**Files:**
- Modify: `apps/web/src/renderer/glow.ts` (`PORTAL_GLOW_STRENGTH`), `apps/web/src/audio/portal-hum.ts` (`HUM_GAIN`),
  if tuning moves them
- Modify: `docs/open-decisions.md` (D29), `AGENTS.md` (Portals gotcha)

- [ ] **Step 1: Tune by eye.**
  - Run the dev server (`pnpm dev`), join a room, press Y, and stand 1.5 tiles in front of a doorway.
  - Compare against the sketch (`/private/tmp/claude-501/-Users-roman-Projects-zoom3d/a9307092-aefc-41d4-abe7-43cdab3cb9c2/scratchpad/portal-glow-sketch.html`;
    serve it with `python3 -m http.server --directory <that dir>`).
  - Set `PORTAL_GLOW_STRENGTH` so the floor and frame read about as pink as the sketch's. Keep the hum's `HUM_GAIN` at
    or under `VACUUM_GAIN` unless it is inaudible.
  - Take a screenshot of the doorway for the report.
- [ ] **Step 2: Run** both benches and record:
  - the portals-off hashes, which must be unchanged;
  - the portals-on doorway and crowd frame times, against D28's (doorway 1.00 ms, crowd 2.99 ms).
- [ ] **Step 3: Write D29** after D28 in `docs/open-decisions.md`, in D28's form. It covers:
  - what the user picked in the sketch: both styles, one pink, 0.8 Hz, 40% depth, and the hum mix;
  - the spill's front-side cut, and why plain glow was rejected;
  - the light sitting 0.6 tiles out;
  - no glow on people or objects, and a pink ceiling;
  - the local pulse clock;
  - the measurements.
- [ ] **Step 4: Add one sentence to the Portals gotcha in `AGENTS.md`:** "Portal windows shimmer and their fronts
  glow and hum (D29): portal glows are avatar glows with a `cut` plane, and every pass that uses glow light must
  honour it."
- [ ] **Step 5: Run** `pnpm lint`. Then commit `git commit -m "Tune and record the portal glow (D29)"`.
