# Eye Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The frame's brightness adapts slowly to what the eye sees, so dim places brighten and bright ones settle.

**Architecture:** A pure module `renderer/eye-adaptation.ts` does four things: it meters a finished frame, moves an
eye level towards the reading, turns the level into a gain, and scales the frame through a 256-entry table.
`renderView` runs it after the main pass and the windows, and before the first-person hands. The room loop owns the
eye's state and hands it to the scene.

**Tech Stack:** TypeScript, Vitest, the software framebuffer (`Uint32Array`, 0xAABBGGRR).

**Spec:** `docs/superpowers/specs/2026-11-01-eye-adaptation-design.md`

## Global Constraints

- Frame cost: about 0.5 ms or less at 640×360. No allocations per frame.
- In ordinary lit places the gain is 1, so the room looks as it does today.
- Adapting up takes about 0.3 s into light and about 1.5 s into the dark. It runs on real time (`dt`), not frames.
- Gain = `(reference / level) ^ strength`, clamped to [`GAIN_MIN`, `GAIN_MAX`]. `strength` is 0.5 and `GAIN_MAX` is
  about 2.5; these are starting values.
- It's off with `scene.lighting === null` (unlit and flat modes). It's frozen while the room is dark in a portal
  sequence, and reset to gain 1 when the room changes.
- Existing `bench:walls` and `bench:sprites` hashes stay unchanged.
- Code style: Biome, braced blocks, `.at()`, comments only say why, and no "you/your" in names.

## Review Focus

1. **A long `dt`** (a tab hidden for a minute, then back) must land on the reading, never overshoot it. Covered by
   the `adapt` test with `dt = 1e6`.
2. **An all-black frame** (pitch dark, or no lamp in view) must give `GAIN_MAX`, never NaN or Infinity. Covered by
   the meter and gain tests.
3. **A frame whose size or FOV changes** (touch relayout rebuilds `fb`): the meter must read the buffer it's given,
   with no grid cached for an old size. Covered by the meter test on two sizes.
4. **`dt` of 0 or below** (two frames on one timestamp): the level stays put, with no NaN. Covered by the `adapt` test.
5. **Gain over 1 on a near-white pixel** must clamp at 255 and keep alpha. Covered by the apply test.

Also: a small bright patch in view (a lamp, about 2% of the frame) mustn't move the reading much, or turning past a
lamp would pump. Covered by the meter test.

---

### Task 1: The eye-adaptation module

**Files:**
- Create: `apps/web/src/renderer/eye-adaptation.ts`
- Test: `apps/web/src/renderer/eye-adaptation.test.ts`

**Interfaces:**
- Produces:
  - `meterFrame(fb: Framebuffer): number`: centre-weighted log-mean luma (0..255 scale) over a sparse grid, about one
    pixel in 64 (every 8th column of every 8th row). It's computed as `exp(Σw·ln(1+luma)/Σw) − 1`, using `luma`
    from `colour.ts` on the encoded channels. That isn't linear light, but it's what the screen shows; this is the
    builder's call to record.
  - `interface Eye { level: number | null }`: `null` means not yet metered, so the first reading is taken as is.
  - `createEye(): Eye`
  - `adaptEye(eye: Eye, reading: number, dtS: number): void`: exponential approach, `1 − exp(−dtS/τ)`, with
    `τ = ADAPT_UP_S` (0.3) when `reading > level`, else `ADAPT_DOWN_S` (1.5). `dtS ≤ 0` leaves it unchanged.
  - `eyeGain(level: number | null): number`: 1 when `level` is null; otherwise the formula above with `REFERENCE`,
    `STRENGTH` = 0.5, `GAIN_MIN` = 0.6 and `GAIN_MAX` = 2.5.
  - `createExposure(): { apply(fb: Framebuffer, gain: number): void }`: keeps one `Uint8Array(256)` table, rebuilt
    when `|gain − tableGain| > GAIN_STEP` (0.01). It skips the pass entirely when gain is exactly 1, and keeps alpha.
  - Exported constants: `ADAPT_UP_S`, `ADAPT_DOWN_S`, `GAIN_MIN`, `GAIN_MAX`, `REFERENCE` (a placeholder of 90 until
    Task 2 measures it).

- [ ] **Step 1: Write the failing tests** in `eye-adaptation.test.ts`, using `createFramebuffer(w, h)` and `rgb`:
  - `meterFrame of a uniform grey frame reads that grey's luma` (grey 100 → `toBeCloseTo(100, 0)`).
  - `meterFrame of a black frame reads 0`.
  - `a bright centre reads higher than the same bright patch at the edge` (a 64×36 white block at the centre against
    one in a corner, on grey 40).
  - `a small bright patch hardly moves the reading` (2% of the pixels at 255 on grey 60 reads `< 60 * 1.25`).
  - `reads any frame size` (a 320×180 and a 640×360 grey frame read the same).
  - `adaptEye: the first reading is taken as is`.
  - `adaptEye rises faster than it falls` (from 50, `dt` 0.3 towards 150 covers more ground than from 150 towards 50).
  - `adaptEye is independent of the frame rate` (10 steps of 0.03 ≈ 1 step of 0.3, `toBeCloseTo` to 1e-9).
  - `adaptEye with a huge dt lands on the reading`, and `with dt 0 or below stays put`.
  - `eyeGain is 1 at REFERENCE and with no level`, `clamps to GAIN_MAX at 0 and GAIN_MIN at 255`, and is never NaN.
  - `apply at gain 1 changes no pixel`, `apply at 2 doubles a dark pixel`, `clamps 200 at 255 and keeps alpha`.

- [ ] **Step 2: Run them to make sure they fail.** Run `pnpm --filter @zoom3d/web exec vitest run src/renderer/eye-adaptation.test.ts`. Expected: FAIL, since the module doesn't exist.

- [ ] **Step 3: Implement the module** with the interfaces above. Nothing is allocated in `meterFrame` or `apply`.

- [ ] **Step 4: Run the tests to make sure they pass**, with the same command. Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "Add the eye adaptation step: meter, adapt, gain, expose"`

### Task 2: Wire it into the frame, measure, document

**Files:**
- Modify: `apps/web/src/renderer/frame.ts`, adding `RoomScene.adaptation` and calling the step in `renderView`
  between the pass and `drawFirstPerson`.
- Modify: `apps/web/src/game/room-loop.ts`, where `describeScene(now, dt)` fills `scene.adaptation`.
- Modify: `apps/web/bench/walls.ts`, adding an "eye adaptation" cost line. It stays out of `MODES`, so the hashes
  stay put.
- Modify: `apps/web/bench/sprites.ts` and every other `RoomScene` literal that typecheck flags, setting
  `adaptation: null`.
- Test: `apps/web/src/renderer/frame.test.ts`
- Docs: `docs/open-decisions.md` (D32), `AGENTS.md` (gotcha), and the spec's status line.

**Interfaces:**
- Consumes: Task 1's `meterFrame`, `adaptEye`, `eyeGain`, `createExposure` and `Eye`.
- Produces: `RoomScene.adaptation: { eye: Eye; dtS: number; frozen: boolean } | null`. When null, nothing runs.
  `renderView` meters and adapts (unless `frozen`), then applies `eyeGain(eye.level)`.

- [ ] **Step 1: Write the failing frame tests:**
  - `with adaptation null the frame is unchanged` (pixels equal to a render without the field).
  - `a dim scene brightens once the eye adapts`: an `Eye` whose `level` is set to 255, as if it had just come from
    a bright place, renders a dim scene with `dtS` 0.01, then again with `dtS` 10. The second frame's whole-frame red
    sum is higher than the first's. A fresh eye wouldn't do: its first reading is taken as is, so both frames would
    get the same gain.
  - `renderView meters the frame before exposing it`: with `level` null and a dim scene, `eye.level` afterwards
    equals `meterFrame` of the same scene rendered with adaptation null.
  - `a frozen eye keeps its level`.
  - `the first-person hands aren't exposed` (the lighter sprite's pixels match a render with adaptation null).

- [ ] **Step 2: Run them to make sure they fail.** Run `pnpm --filter @zoom3d/web exec vitest run src/renderer/frame.test.ts`.

- [ ] **Step 3: Wire it.** In room-loop:
  - Keep one `Eye` and the `Room` it was made for, and call `createEye()` again when `o.room()` differs.
  - Set `adaptation` to null when `scene.lighting` is null.
  - Pass `frozen: room?.sequence.dark ?? false` and the frame's `dt`.

- [ ] **Step 4: Run the tests** (`pnpm test`, `pnpm typecheck`, `pnpm lint`). Expected: all green.

- [ ] **Step 5: Measure.**
  - Run `pnpm bench:walls`. The existing hashes must be unchanged, and the adaptation line must be ≤ 0.5 ms.
  - Set `REFERENCE` to the median `meterFrame` over the bench's lamp poses, and record that median.

- [ ] **Step 6: Docs.**
  - D32: the approach, the numbers, the measurement, and that the hands are left out.
  - AGENTS.md gotcha: exposure runs after the windows and before the hands; it's frozen in the blackout; never
    meter or expose inside a pass.
  - Spec status: "approved and built (D32)".

- [ ] **Step 7: Commit.** `git commit -m "Adapt the eye to the frame's brightness (D32)"`
