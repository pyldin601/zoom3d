# Scooter Motor Buzz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The scooter's motor whine goes through a load-driven soft clipper, and its wheels roll (ticks into wheel
modes) instead of hissing, with the values the owner tuned on the Scooter Motor Buzz listening page.

**Architecture:** In `createScooterSound`, between the once-a-turn pulse and the housing dip: drive gain →
`WaveShaperNode` (curve from a pure `buzzCurve`) → 20 Hz highpass (the asymmetry's DC) → lowpass → makeup gain. `set()`
glides the drive and the makeup per load; the makeup is the pure `buzzMakeup(driveGain)` level match times the owner's
trim.

**Tech Stack:** TypeScript, Web Audio, vitest with `apps/web/src/audio/fake-audio.ts`.

**Spec:** [docs/superpowers/specs/2026-11-09-scooter-motor-buzz-design.md](../specs/2026-11-09-scooter-motor-buzz-design.md)

## Global Constraints

- The owner's values (listening page, 2026-11-09), verbatim: drive pulling 14 dB, cruising 5 dB, coasting 0 dB;
  hardness 0.28; asymmetry 0.19; lowpass 2310 Hz; makeup −5.5 dB; slot tone level 0.24 (was 0.3), kept.
- The page's curve, exactly: `shape(x) = tanh(x)·(1 − h) + clamp(tanh(k·x)/tanh(k), −1, 1)·h`, `k = 1 + 6h`; the curve
  holds `shape(x + a) − shape(a)` for x over −4..4 in 4096 points; `oversample: '4x'`.
- The level match, exactly: `buzzMakeup(g) = 0.75 / |shape(0.75·g + a) − shape(a)|` (0.75: the summed whine's peak).
- Lowpass and highpass Q 0.7; highpass 20 Hz.
- Wheels (owner, same page): 900 ticks/s at full speed; swell 0.35; level 0.6 × (speed / 6)^1.2; modes 190 Hz Q 9
  level 0.6, 460 Hz Q 7 level 0.35, 1150 Hz Q 5 level 0.15, each lifted by 2Q (lift = 2 · Q · level).
- Ticks, exactly as the page: Poisson spacing, height `min(1, −ln(1 − u) · 0.4)`, random sign, in a 4 s looped
  buffer played at `max(0.001, speed / 6)`.
- No noise added; PWM whiss, wheels, seams and bumps unchanged. No allocation per `set()` (the curve is built once per
  sound).
- Code style: `docs/code-style.md`, braced blocks, `.at()` over index casts; Biome.

## Review Focus

- Coasting at 0 dB still goes through the clipper (a near-clean 0.75 peak, not bypassed): its makeup must stay finite
  and near 1 → test `buzzMakeup(1)` is finite and within 0.9..1.3.
- Load flips glide, never jump: drive and makeup use `setTargetAtTime` → test the drive gain's last target per load.
- A ride ended (`dispose`) must still stop cleanly with the new nodes in the chain → the existing dispose test passes.
- Peers and the own scooter share the synth, so both get the buzz → no extra test (one code path).
- The curve is odd-centred: `curve` at its midpoint is 0 (no DC at silence) → test.

---

### Task 1: The buzz curve and level match

**Files:**
- Modify: `apps/web/src/audio/scooter-sound.ts` (constants, exported pure functions)
- Test: `apps/web/src/audio/scooter-sound.test.ts` (new `describe('the buzz')`)

**Interfaces:**
- Produces: `export function buzzCurve(): Float32Array` (4096 points, owner's hardness/asymmetry);
  `export function buzzDriveDb(load: ScooterLoad): number`; `export function buzzMakeup(driveGain: number): number`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('the buzz', () => {
  test("drives the clipper by load, as the owner tuned it: 14, 5 and 0 dB", () => {
    expect(['pulling', 'cruising', 'coasting'].map((l) => buzzDriveDb(l as ScooterLoad))).toEqual([14, 5, 0]);
  });
  test('the curve is 4096 points, silent at silence, and squashes but never exceeds a full swing', () => {
    const curve = buzzCurve();
    expect(curve).toHaveLength(4096);
    expect(Math.abs((curve.at(2047)! + curve.at(2048)!) / 2)).toBeLessThan(1e-3);
    expect(Math.max(...curve.map(Math.abs))).toBeLessThan(2.2);
  });
  test('it clips one side sooner: its top and bottom differ', () => {
    const curve = buzzCurve();
    expect(Math.abs(curve.at(-1)! + curve.at(0)!)).toBeGreaterThan(0.05);
  });
  test('the level match keeps the whine as loud as clean, finite at 0 dB', () => {
    expect(buzzMakeup(1)).toBeGreaterThan(0.9);
    expect(buzzMakeup(1)).toBeLessThan(1.3);
    expect(buzzMakeup(10 ** (14 / 20))).toBeGreaterThan(buzzMakeup(1));
  });
});
```

- [ ] **Step 2:** `pnpm --filter @zoom3d/web exec vitest run src/audio/scooter-sound.test.ts` → FAIL (not exported).
- [ ] **Step 3:** Implement the three functions and constants (`BUZZ_DRIVE_DB`, `BUZZ_HARDNESS`, `BUZZ_ASYMMETRY`,
  `BUZZ_CURVE_RANGE = 4`, `BUZZ_CURVE_POINTS = 4096`, `WHINE_PEAK = 0.75`) with the Global Constraints formulas.
- [ ] **Step 4:** Same command → PASS.

### Task 2: The buzz in the whine path

**Files:**
- Modify: `apps/web/src/audio/fake-audio.ts` (add `createWaveShaper()`: a `FakeNode('waveshaper')` with `curve` and
  `oversample` fields)
- Modify: `apps/web/src/audio/scooter-sound.ts` (`createScooterSound`, `set`; slot tone level 0.24)
- Test: `apps/web/src/audio/scooter-sound.test.ts`

**Interfaces:**
- Consumes: `buzzCurve`, `buzzDriveDb`, `buzzMakeup` from Task 1.

- [ ] **Step 1: Write the failing tests**
  - `'the whine goes pulse → drive → clipper (4x) → 20 Hz highpass → 2310 Hz lowpass → makeup → housing'`: find the
    `waveshaper` node, assert `oversample === '4x'`, its curve equals `buzzCurve()`, and follow `connections` to the
    highpass (20 Hz), the lowpass (2310 Hz) and on to the `peaking` housing.
  - `'speeding up drives it 14 dB, holding speed 5, coasting 0, with the makeup −5.5 dB on the level match'`: after
    `set(3, load, DT)`, the gain feeding the shaper's last target is `10 ** (db / 20)` and the makeup's is
    `buzzMakeup(10 ** (db / 20)) * 10 ** (-5.5 / 20)`, for each load.
  - Update the tone-levels test: the slot tone's level is 0.24.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Build the chain once in `createScooterSound` and glide drive and makeup in `set()`.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, `pnpm lint` → all pass.
- [ ] **Step 5:** Record in D36 (`docs/open-decisions.md`) and the scooter sound spec; mark the design's "Tuning first"
  done with the values; commit `Give the scooter motor a load-driven buzz`.

### Task 3: Rolling wheels

**Files:**
- Modify: `apps/web/src/audio/fake-audio.ts` (buffer sources get a `playbackRate` param)
- Modify: `apps/web/src/audio/scooter-sound.ts` (wheels layer; `wheelLevel` → `rollLevel`; the white-noise roll goes)
- Test: `apps/web/src/audio/scooter-sound.test.ts`

**Interfaces:**
- Produces: `export function rollLevel(speed: number): number`; `export function grainRate(speed: number): number`;
  `export function fillTicks(data: Float32Array, sampleRate: number, perSecond: number, random?: () => number): void`.

- [ ] **Step 1: Write the failing tests**
  - `rollLevel`: 0.6 at full speed, `0.6 · 0.5^1.2` at half, 0 at rest (replaces the wheel-level test).
  - `grainRate`: 1 at full speed, 0.5 at half, 0.001 at rest.
  - `fillTicks` over 4 s at 48 kHz, 900/s: between 3240 and 3960 ticks, every height ≤ 1, both signs.
  - `'the wheels roll: ticks into modes at 190, 460 and 1150 Hz (Q 9, 7, 5), lifted 10.8, 4.9 and 1.5'`.
  - `'the ticks play faster with speed, and the roll swells once a wheel turn with the whine's pulse'`: after
    `set(3, …)` the tick source's `playbackRate` targets 0.5; the swell gain rests at 0.825 and the shimmer
    oscillator feeds a 0.175 gain into it.
  - The old 1260 Hz roll band is gone.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; the ticks share the whine's shimmer oscillator for the swell (same rate).
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, `pnpm lint` → pass. Then Task 2's Step 5 covers docs and commit for
  all three.

