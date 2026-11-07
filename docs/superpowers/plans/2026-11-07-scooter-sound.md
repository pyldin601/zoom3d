# Scooter Sound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the speed-pitched scooter whine with the owner's tuned sound:
- a fixed 7800 Hz PWM whiss;
- a low motor tone up to 157 Hz;
- barely-there wheels with seam ticks;
- bumps as a thud and a rattle.

There is no ring and no scrape sound.

**Architecture:** One synth per scooter sound (`audio/scooter-sound.ts`) takes speed, a load
(`'pulling' | 'cruising' | 'coasting'`) and bumps. The manager (`audio/scooter-sounds.ts`) works out others' load and
bumps from their drawn motion. The local player's load comes from the input and their bump from `stepRide`.

**Tech Stack:** TypeScript, Web Audio, vitest with `audio/fake-audio.ts`.

**Spec:** `docs/superpowers/specs/2026-11-07-scooter-sound-design.md`

## Global Constraints

- All values come from spec §4, verbatim. The master is 0.6, and every glide has τ 0.05 s.
- There is no ring, no scrape sound, and no protocol or server change.
- No per-frame allocations except one-shot nodes for a seam tick or a bump (as the vacuum's beeps do).

## Review Focus

1. A rider stopping by braking hard never triggers a bump on others' screens (10 < 25 tiles/s²). Test in Task 3.
2. A portal jump or correction never triggers a bump. Test in Task 3.
3. A rider pressing into a wall makes at most one bump per 0.3 s, not one per frame. Tests in Task 1 (the own bump
   fires on the stopping step only) and Task 3.
4. The tab is hidden, then shown: the own sound gets `coasting` at speed 0 from the hidden ticker, with no bump. Test in
   Task 3.
5. A rider who leaves mid-bump: the whine is detached; one-shots finish on their own. Covered by the existing leave
   test in Task 3.

---

### Task 1: `stepRide` reports a head-on stop

**Files:** Modify `apps/web/src/game/scooter-physics.ts` (+ test).

**Interfaces:** `RideState` gains `bump: number`: the speed just before a head-on stop on this step, else 0.
`createRideState()` sets it to 0.

- [ ] **Step 1:** Write the failing tests:
  - `a head-on stop reports the speed it hit at, once`: speed 6 toward the wall; the step that stops it has
    `bump ≈ 6`; the next step has `bump === 0`.
  - `scraping reports no bump`: the 45° scrape setup; `bump` is 0 on every step.
- [ ] **Step 2:** Run `pnpm --filter @zoom3d/web exec vitest run src/game/scooter-physics.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement it: set `ride.bump` on every step, the speed when a head-on stop zeroes it, else 0.
- [ ] **Step 4:** Run `pnpm test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit "Report a scooter's head-on stop as a bump".

### Task 2: The tuned synth

**Files:** Rewrite `apps/web/src/audio/scooter-sound.ts` (+ test).

**Interfaces:**
- Produces:
  - `type ScooterLoad = 'pulling' | 'cruising' | 'coasting'`;
  - `SCOOTER_MASTER = 0.6`;
  - `pwmLevel(load, speed): number`;
  - `motorToneHz(speed): number`;
  - `motorLevel(load, speed): number`;
  - `wheelLevel(speed): number`;
  - `createScooterSound(ctx)`, returning `{ output: AudioNode; set(speed: number, load: ScooterLoad, dtSeconds: number): void; bump(impact: number): void; dispose(): void }`.
- Removes `whinePitchHz`, `whineLevel` and `SCOOTER_GAIN`.

- [ ] **Step 1: Write the failing tests** (`scooter-sound.test.ts`, replacing the whine tests):
  - **`pwmLevel`:**
    - pulling 0.35;
    - cruising 0.18;
    - coasting 0.02 at speed ≥ 0.3;
    - coasting 0.01 at speed 0.15;
    - coasting 0 at speed 0.
  - **`motorToneHz`:** 157 at 6, 30 at 0, 78.5 at 3.
  - **`motorLevel`:** pulling 0.03, cruising 0.02, coasting 0.01 at speed ≥ 0.3.
  - **`wheelLevel`:** 0.12 at 6, `0.12 × 0.5^1.2` at 3, 0 at 0.
  - **The whiss is fixed:** after `set(1, 'pulling', …)` and `set(6, 'pulling', …)`, the sine whose `frequency.value`
    is 7800 has no target other than 7800.
  - **Loudest under unity:** `20·log10(SCOOTER_MASTER × 0.35) ≤ −12`.
  - **Seam ticks:** `set(3, 'coasting', 1/60)` for 60 frames (3 tiles) creates 3 band-pass filters at 3200 Hz.
  - **No ticks below 0.3 tiles/s:** at speed 0.2 for 600 frames, no 3200 Hz filters are created.
  - **A bump:** `bump(1)` creates one sine whose frequency sweeps from 136 to 85 Hz, and one band-pass at 1500 Hz. No
    other oscillator is created (no ring).
  - **Fade on stop:** `dispose()` glides every layer's gain to 0, and the oscillators stop after `ctx.currentTime`.
- [ ] **Step 2:** Run `pnpm --filter @zoom3d/web exec vitest run src/audio/scooter-sound.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement it, with the node graph and values of spec §4. Seam ticks come from a distance accumulator
  inside `set`.
- [ ] **Step 4:** Run the test. Expected: PASS. (`scooter-sounds.ts` breaks until Task 3, so commit both together.)

### Task 3: Load and bumps in the manager, and the wiring

**Files:**
- Modify `apps/web/src/audio/scooter-sounds.ts` (+ test).
- Modify `apps/web/src/game/room-loop.ts`.

**Interfaces:**
- `ScooterSounds.own(speed: number, load: ScooterLoad, bump: number, riding: boolean)`.
- `sync` is unchanged in signature.
- `ownLoad(forward: number, speed: number): ScooterLoad` is exported from `scooter-sounds.ts`:
  - `forward > 0` and speed < `RIDE_SPEED` gives pulling;
  - `forward > 0` at top speed gives cruising;
  - anything else gives coasting.

**Behaviour for others:**
- **Load:** from the smoothed speed's change per second:
  - more than +0.5 tiles/s² is pulling;
  - within ±0.5 while moving (≥ 0.3 tiles/s) is cruising;
  - anything else is coasting.
- **Bump:** the frame's unsmoothed speed `raw` (0 on a jump over `JUMP_TILES`) is compared with the previous frame's
  `lastRaw`. A drop of over 1.5 tiles/s at over 25 tiles/s² plays `bump(max(0.15, lastRaw / 6))`, at most once per
  0.3 s per rider. A jump frame resets `lastRaw` to 0, so the jump itself never counts.

- [ ] **Step 1: Write the failing tests** (`scooter-sounds.test.ts`):
  - **`ownLoad`:** the three cases.
  - **`others' load follows their motion`:** steadily accelerating positions produce pulling (the whiss gain target is
    0.35 × the master path). Constant speed produces cruising. Slowing at 1.5 tiles/s² produces coasting.
  - **`a sudden stop plays one bump`:** at 6 tiles/s for 30 frames, then still. Exactly one 85 Hz sweep is created,
    and none after 30 more still frames.
  - **`hard braking plays no bump`:** slowing at 10 tiles/s² to 0. No bump.
  - **`a portal jump plays no bump`:** at 3 tiles/s, then a 5-tile jump, then still. No bump.
  - **`the own bump plays from ride.bump`:** `own(0, 'coasting', 6, true)` creates one thud.
  - **`the hidden ticker's own call plays nothing new`:** `own(0, 'coasting', 0, true)` creates no thud.
  - The existing leave and step-off tests keep passing.
- [ ] **Step 2:** Run `pnpm --filter @zoom3d/web exec vitest run src/audio`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - `room-loop.ts` passes `ownLoad(o.input.state().forward, localPlayer.ride.speed)` and `localPlayer.ride.bump` to
    `own`.
  - The hidden ticker passes `own(0, 'coasting', 0, riding)`.
  - Drop `lastOwnSpeed` and `OWN_SPEEDING_UP`.
- [ ] **Step 4:** Run `pnpm test`, `pnpm typecheck` and `pnpm lint`. Expected: PASS.
- [ ] **Step 5:** Commit Tasks 2 and 3: "Play the owner's tuned scooter sound: PWM whiss, motor tone, wheels and
  bumps".

### Task 4: Docs

- [ ] **Step 1:** In D36, replace the "A motor whine" bullet with the tuned sound:
  - the owner tuned it by ear on a listening page, 2026-11-07;
  - the whiss is fixed at 7800 Hz; the owner said a PWM motor has no pitch, then added a low motor tone back;
  - wheels and seam ticks;
  - bumps are a thud and a rattle; the owner dropped the ring;
  - no scrape sound (owner);
  - others' load and bumps come from their motion.

  In the electric spec, mark §4.4 as replaced by the scooter sound spec.
- [ ] **Step 2:** Run `pnpm lint`. Commit "Record the tuned scooter sound".
