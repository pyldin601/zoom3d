# Slow light — design

Date: 2026-11-22. Status: draft for the owner's approval. Decision: D39 (to be recorded in `docs/open-decisions.md`).

## 1. Intent

A fun look to play with: what the room would look like if light were slow enough to matter, about as fast as a
scooter. Walking and riding make the view bend, tint and brighten, and people far away are seen where they were a
second or two ago. It is a toy, not a physics lesson: the colours are a stylised tint, not a spectral simulation.

Like realistic portals (D38) it is a **per-person look**: only the local player's screen changes. Nothing goes on the
wire, the server is untouched, and gameplay (moves, kicks, E, collisions) reads true positions as today.

## 2. Goals, non-goals, anti-goals

Goals, the four effects:

1. **Light delay.** Every remote person and object (peers, bots, the ball, the vacuum, parked scooters) and the local
   player's own disc seen through a portal is drawn where it was when the light now reaching the eye left it.
2. **Aberration.** While the local player moves, the view crowds toward the direction of motion and spreads behind.
3. **Doppler tint.** Toward the motion the frame tints blue, away from it red, stronger with speed.
4. **Searchlight.** Toward the motion the frame brightens, away from it it dims.

Plus: a console toggle and a slider for c, persisted with the other render settings.

Non-goals: sound changes (no propagation delay or Doppler pitch on voices; possible later); vertical aberration;
Lorentz contraction or Terrell rotation of moving discs; delaying face video or voices (they stay live); time dilation;
anything on touch devices beyond what the console already offers; showing what is behind the eye.

Anti-goals: the look off must draw today's frame pixel for pixel (`pnpm bench:walls` and `bench:sprites` hashes
unchanged); no allocations per frame or per column; no change to what other people see or what the server does.

## 3. Approaches

- **A. Post-process the finished frame (chosen by the owner).** Draw the room as today into a wider source frame, then
  resample its columns to where aberration puts them and multiply in a per-column tint and brightness. No renderer
  pass changes. Costs: a wider source frame, a softer centre at speed, no vertical aberration, a cap on β.
- **B. Bend each column's ray inside every pass.** Physically complete (even shows behind the eye at speed), but
  touches walls, floors, mirror, shadows, glows, sprites, voxels, labels and portal windows, puts work in the
  per-column hot path, and needs "off is unchanged" proven everywhere. Several times the work for a toy.

## 4. Design

### 4.1 Settings

`RenderSettings` (`ui/render-settings.ts`) gains `light: 'instant' | 'slow'` (default `'instant'`) and
`lightSpeed: number` (tiles/s, default 12). `normalizeRenderSettings` checks each on its own; `lightSpeed` is clamped to
the slider's range, 6–60 tiles/s, step 1. Kept apart from `light` so the slider remembers its value while off. The
console's renderer section (`ui/console-panel.ts`, next to the Portals row) gets a Light row (Instant / Slow) and a
"Speed of light" slider showing tiles/s and m/s (1 tile ≈ 0.47 m, from walking 3 tiles/s ≈ 1.4 m/s).

### 4.2 Speeds and the cap

β = |v| / c, where v is the local player's own velocity in tiles/s. Walking is 3 tiles/s, riding up to `RIDE_SPEED` 6.
**β is capped at 0.5**: beyond it the source view would need more than about 130° (§4.4). So at the default c = 12 a
scooter at full speed reaches exactly the cap, walking is 0.25; below c = 12 the effects stop growing when riding fast.
The cap applies to aberration, tint and searchlight only; light delay uses c as set.

v is measured from the local player's pose: displacement over the frame's dt, smoothed over about 100 ms (builder
tunes), with a step through a portal (a jump in position) ignored rather than read as a huge speed. Its direction is
taken relative to the camera's facing, `localPlayer.eye()`, so riding with the head turned bends the view sideways.
Turning on the spot is no velocity.

### 4.3 Light delay

For each remote thing the drawn time is `now − tierDelay − d / c`, where `tierDelay` is today's (`PeerDelay`, or
`INTERP_DELAY_MS` for objects) and d is the distance from the eye now to the thing's apparent position at the drawn
time: one portal deep through `room.sightPortals()`, the same image `apparentPosition` gives. d depends on the drawn
time, so solve it by a few fixed-point steps (start from today's drawn pose, two or three steps, builder checks
convergence at the speeds above; things faster than c can have several solutions: take the latest).

Everything that reads drawn positions follows: discs, riders' scooters, held items, glows, lighters and headlights,
labels, the automap, face subscription, and every sound placed from them (voices, the vacuum hum, motor whine, ball
sounds, portal hums). So `RemoteWorld` keeps one sample per thing, the delayed one; sounds come from where things are
seen (my call: one sample keeps the data layout as today, and hearing a thing where it is seen suits the toy). Voice and
face timing stay live.

**One delay per thing (my call).** A thing seen both directly and through a portal window is drawn at one delayed
pose, computed from the image `apparentPosition` picks, in every pass. Giving each image its own delay would need a
separate set of sprites, voxels, glows and labels per window pass, which is the renderer surgery approach A avoids. The
local player's own disc, seen only through windows, takes its delay from its nearest window image (`imagePosition`, as
`placeOwnLabel` does).

- **History.** `SnapshotBuffer` capacity (32) holds about 2 s of near updates. It must hold the largest delay at the
  slowest c: room extent ~40 tiles ÷ 6 tiles/s ≈ 7 s. Grow capacity for peers and objects (about 128; builder's call,
  allocation-free as today). Past the oldest entry, hold the oldest.
- **The ball.** It is drawn from the client's prediction in the present (D26). With slow light on, keep a short ring of
  its shown positions (per frame or per tick) and sample that by the same rule. Dribbled by someone else it already
  follows the dribbler's drawn pose. Dribbled by the local player it stays in the present (half a tile ≈ 40 ms).
- **Own disc through portals.** Keep a ring of the local player's own poses and draw `self` (and `ownScooter`, own
  label) at its delayed pose: through a portal the local player sees themselves a moment ago.
- **Pauses.** `holdBefore` keeps working on the delayed time.

### 4.4 Source frame

With slow light on, the room is drawn into a **source framebuffer** with a fixed wider FOV, then resampled into the
normal frame. Worst case over all velocity directions at β = 0.5 with today's 66° frame, the source must reach 64° from
facing; at FOV_TALL (50°) 56°. The source FOV is fixed at 130° (builder may derive it from the frame's FOV), so it is
built once when the look turns on or the frame changes, never per frame (AGENTS: the buffer is rebuilt only when size or
FOV changes). Its width is **2× the frame's** (owner, 2026-11-22). At 130° that leaves the centre at about 0.6× today's
detail, even standing still, as the resample always runs while the look is on: soft is fine for this toy. Keep the factor
one named constant, so it can be raised if it looks too soft in play (3.2× would match today's centre at about 3× the
cost). Window framebuffers follow the source frame's size, as `ensureWindows` sizes them to the frame they draw into.
`pnpm bench:walls` reports frame time with the look on; it is not a gate.

Everything `renderView` draws through `drawPass` (walls, sprites, voxels, mirror, windows) goes into the source frame.
`drawFirstPerson` (fists, items, handlebar, boombox) draws afterwards into the output frame, unbent.

### 4.5 Resample, tint and searchlight

Per frame, when v or the facing changed, fill per-output-column tables (preallocated typed arrays, rebuilt only on
frame change):

- apparent angle α' of the column from the facing (from the output frame's planar projection);
- source angle α by inverse aberration about the velocity direction φ: with θ' = α' − φ,
  cos θ = (cos θ' − β) / (1 − β cos θ'), same side as θ'; α = θ + φ;
- source column from α through the source frame's planar projection;
- vertical scale k so heights match: output `proj_o / cos α'` over source `proj_s / cos α`; out row y reads source row
  `half + (y − half) / k` (nearest, retro);
- Doppler factor D = γ (1 + β cos θ'), γ = 1 / √(1 − β²);
- a per-channel multiplier from D: stylised blue tint for D > 1, red for D < 1, strength ∝ ln D, times searchlight
  brightness D^n (n ≈ 2), clamped so neither end blows out or goes black. Constants are the builder's starting point;
  the owner tunes by playing.

The resample is one pass over the output: per column, per row, read source pixel, scale RGB by the column's
multipliers. At β = 0 the tint is identity; the source → output resample still runs while the look is on.

Labels are projected through the source view (`drawLabels` takes the source framebuffer), then their x mapped through
the inverse column table and their height by k. Face subscription keeps reading what the source pass drew (`seen`):
faces may count a little smaller than shown, so may pick a smaller face size; acceptable (builder's call).

### 4.6 Off is today

`light: 'instant'` takes none of these paths: no source frame, no extra history pushes beyond the larger capacity, the
drawn time exactly today's. The pixel hashes of `bench:walls` and `bench:sprites` must not change.

## 5. Tests (written first)

Pure logic, in vitest: settings normalising (bad/missing values, clamping); aberration angle mapping and its inverse
(β = 0 identity, symmetric, forward crowding, the cap); Doppler factor and tint (identity at β = 0, blue ahead, red
behind, clamps); the column tables (monotonic, in range); the retarded-time solve (static thing → d/c, approaching and
receding things, faster than c takes the latest, through a portal uses the image distance); velocity from poses
(portal jump ignored, smoothing); history holds the oldest when the delay outgrows it.

Manual (owner plays): look, tint and brightness levels, sharpness, frame rate.

## 6. Left to the builder

Velocity smoothing window; history capacity; source width factor (by bench); tint and searchlight constants and clamps;
fixed-point step count; sampling nearest vs linear in the resample; where the source frame and tables live (a
`renderer/slow-light.ts` module is the natural home, with pure maths in its own file for tests).
