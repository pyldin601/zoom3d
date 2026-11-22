# Honest Slow Light Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace D39's column stretch and painted tint with exact 2D aberration, the correct Doppler factor with real
brightness, and a spectral colour shift, still as a post-process.

**Architecture:** `renderer/spectrum.ts` tabulates a 3×3 colour matrix per Doppler factor and the sRGB/tone tables.
`renderer/slow-light-math.ts` becomes vector aberration and Doppler. `renderer/slow-light.ts` keeps the `Bend` shape
(fit, aim, apply, read range) but fits a taller source, fills an 8 px grid of exact source positions and D indices,
and resamples per pixel through the colour tables. Labels map through forward aberration.

**Tech Stack:** TypeScript, vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-22-slow-light-honest-design.md` (and D39's
`2026-11-22-slow-light-design.md` for what stays).

## Global Constraints

- The look off is pixel-identical: `bench:walls` and `bench:sprites` hashes equal `main`'s.
- No allocation per frame; tables rebuilt only on fit (frame size) or load.
- β cap 0.5 (`MAX_BETA`); `SOURCE_WIDTH_FACTOR` 2; `GRID_PX` 8; `DOPPLER_STEPS` 256 over ln D ∈ [ln 0.5, ln 2].
- Spectrum: Gaussians 450/540/610 nm σ 35; `IR_TAIL` 0.6 split equally, half-Gaussian σ 300 past 700 nm; no UV;
  integrate 300–1500 nm step 2; observed `D⁵ ∫ sens_i(λ) B_j(λ·D) dλ`; `M(D) = A(1)⁻¹ A(D)`.
- Tone: identity ≤ 0.8, then `0.8 + 0.2(1 − e^{−(x−0.8)/0.2})`; negatives clamp to 0.
- Camera space: x facing, y right, z down; square pixels share `proj`.
- Code style as AGENTS.md; test first; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Portrait touch frame (`FOV_TALL`, e.g. 360×640): the fitted source covers every grid point (Task 3 test).
2. Motion exactly along a pixel's direction (n' ∥ v): no NaN from normalising a zero perpendicular (Task 2 test).
3. D outside the table (rounding at β = 0.5): index clamps, never reads past the table (Task 1 test).
4. Very bright source pixels (255) ahead: tone curve keeps channels ≤ 255, no wraparound in packing (Task 3 test).
5. The look toggled off and on: the old remap state is not reused for a different frame size (Task 3 test, fit).

---

### Task 1: Spectrum and colour tables

**Files:** Create `apps/web/src/renderer/spectrum.ts`; Test `apps/web/src/renderer/spectrum.test.ts`

**Interfaces — Produces:**
- `DOPPLER_STEPS = 256`, `MIN_LN_D = Math.log(0.5)`, `MAX_LN_D = Math.log(2)`.
- `dopplerIndex(d: number): number` — integer in [0, DOPPLER_STEPS − 1], clamped.
- `SHIFT_MATRICES: Float32Array` — `DOPPLER_STEPS × 9`, row-major `M(D)` per index.
- `SRGB_TO_LINEAR: Float32Array` (256); `linearToSrgbByte(x: number): number` — tone curve + sRGB via a 4096 table,
  0..255 integer.
- `toneCurve(x: number): number`; `shiftMatrix(d: number, out: Float32Array): Float32Array` (exact, used to build
  the table and in tests).

- [ ] Tests: `the matrix is the identity at rest`; `grey brightens ahead and darkens behind` (sum of `M·(1,1,1)` at 1.5
  > 3 > at 0.6); `a pure blue source still shows ahead from its infrared, toward blue-white`; `beside, green slides
  toward red` (D 0.87: `M·(0,1,0)` red > 0); `the tone curve is the identity to 0.8, rises, and stays below 1`;
  `dopplerIndex clamps outside the table`; `linear to sRGB round-trips bytes at rest` (|byte − f(SRGB_TO_LINEAR[byte])|
  ≤ 1 for bytes whose linear ≤ 0.8).
- [ ] Run `pnpm --filter @zoom3d/web exec vitest run src/renderer/spectrum.test.ts` — FAIL, implement, PASS.
- [ ] Commit `Model the spectrum for slow light's colour shift`.

### Task 2: Vector aberration and Doppler

**Files:** Modify `apps/web/src/renderer/slow-light-math.ts`, its test.

**Interfaces — Produces:** keep `MAX_BETA`, `SOURCE_WIDTH_FACTOR`, `betaOf`, `Motion`; add
`interface Dir { x: number; y: number; z: number }`;
`aberrate(n: Dir, motionAngle: number, beta: number, out: Dir): Dir` — inverse aberration (seen → came from) for
`beta > 0`, forward for `beta < 0` (pass −β); unit in, unit out; `dopplerAlong(n: Dir, motionAngle: number, beta:
number): number` — D for the seen direction. Remove `sourceAngle`, `dopplerFactor`, `tintOf`, `Rgb`, `SOURCE_FOV`.

- [ ] Tests: identity at β 0; inverse then forward returns n (1e-9); the motion direction is fixed; crowding (source
  angle to v larger than seen); a column of seen directions at y = 0.4 maps to varying source y/x across z (lines bend);
  n' ∥ v gives a finite unit result; Doppler 1 / 1.732 / 0.577 / 0.866.
- [ ] FAIL → implement → PASS; commit `Aberrate and Doppler-shift directions in three dimensions`.

### Task 3: The 2D bend

**Files:** Modify `apps/web/src/renderer/slow-light.ts`, its test.

**Interfaces — Produces:** `Bend` keeps `fit(output): Framebuffer`, `aim(output, motion)`, `apply(source, output)`,
`readFrom`, `readTo`; drops the column tables, `toOutputX`, `scaleAt`; adds
`toOutput(sourceX: number, sourceY: number, out: { x: number; y: number; scale: number }): boolean` (false when the
frame doesn't show it) and readonly grid arrays for tests: `gridX`, `gridY: Float32Array`, `gridD: Uint8Array`,
`gridCols`, `gridRows`.

`fit` per spec §4.2 (scan the border at β = MAX_BETA every 5° of motion, 2% margin; FOV from the widest
|n_y/n_x|, height = `ceil(2 · proj_s · max|n_z/n_x|)`). `aim` fills the grid when β or the angle changed. `apply`:
bilinear per pixel, then `SHIFT_MATRICES`, `SRGB_TO_LINEAR`, `linearToSrgbByte`; zbuffer per column at the eye row.

- [ ] Tests: fit keeps one source per frame size and covers every grid point at β 0.5 for 640×360 `FOV_WIDE` and
  360×640 `FOV_TALL`; at rest a flat source is copied unchanged; at β 0.5 the bilinear source position at a cell centre
  is within 0.5 px of the exact map; a bright source (255,255,255) ahead stays ≤ 255 per channel and brighter than
  behind; ahead looks bluer than behind relative to a grey source; `toOutput` inverts the grid (source of a pixel maps
  back within 1 px) and is false for the source's corner; read range spans the grid's source x.
- [ ] FAIL → implement → PASS; commit `Bend the frame by exact aberration and shift its spectrum`.

### Task 4: Labels and bench

**Files:** Modify `apps/web/src/renderer/labels.ts`, `apps/web/bench/walls.ts`; tests `frame.test.ts` (unchanged,
must pass).

- [ ] `drawLabels` with a bend: project in the source, `bend.toOutput(screenX, half, out)`, skip when false, size
  × `out.scale`.
- [ ] Bench case stays (now taller source); run `pnpm test`, `pnpm typecheck`, `pnpm lint`, both benches: hashes equal
  main's; note the bent frame time (target ≈ 8 ms).
- [ ] Commit `Place labels through the exact bend and bench it`.

### Task 5: Verify and record

- [ ] In the dev server (`?bots=20`), Light: Slow at c 6 and 12: screenshots at rest, walking, strafing; no console
  errors.
- [ ] `docs/open-decisions.md`: D40 (the three calls: grid, matrix, soft shoulder; IR follows brightness, no UV);
  mark the D39 minors fixed (Doppler formula); AGENTS.md slow-light line mentions the spectrum and 2D remap.
- [ ] Commit `Record D40: honest slow light`.
