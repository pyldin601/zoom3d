# Slow light, made honest — design

Date: 2026-11-22. Status: approved to build (owner: "design 1–3, then implement"). Decision: D40, building on D39
([slow light](2026-11-22-slow-light-design.md)).

## 1. Intent

The first slow light (D39) reads as a flat stretch. The owner wants it close to a real simulation. Three things make
the view while moving honest without touching the renderer's passes:

1. **Exact aberration.** Every pixel is read from the direction its light really came from, so the view crowds toward
   the point the local player is heading for and straight lines bend.
2. **The correct Doppler factor with real brightness.** D = 1 / (γ(1 − β cos θ')), and radiance scales as D³ per
   frequency (D⁴ in all), not a stylised D² clamp.
3. **A spectral colour shift.** Each colour is a spectrum, shifted in wavelength, then seen through the eye's red,
   green and blue sensitivities. Hues really move instead of a painted tint.

The light delay of moving things (D39) stays as it is. Still a per-person look: the look off is today's frame, pixel
for pixel.

## 2. Goals, non-goals, anti-goals

Goals: the three above, at β up to 0.5 (unchanged cap); on desktop and touch frames.

Non-goals: per-pixel light delay (shape of fast things, time-varying light: a separate step); speeds near c and seeing
behind (needs a 360° renderer); sound.

Anti-goals: the look off changes nothing (`bench:walls` / `bench:sprites` hashes); no per-frame allocation; the bent
frame stays playable (target: about 8 ms at 640×360 on the dev machine, reported by `bench:walls`).

## 3. Approaches

- **Remap: a coarse exact grid, interpolated (chosen).** The source direction, its source pixel and the Doppler factor
  are exact at the corners of a grid of 8×8-pixel cells and bilinear inside. The map is smooth, so the error is far
  below a pixel, and a moving player costs about 4 000 exact evaluations a frame instead of 230 000.
  Rejected: an exact table per pixel (230 000 trig evaluations every frame the player moves); the column remap of D39
  (straight lines can't bend).
- **Spectrum: a 3×3 matrix per Doppler factor (chosen).** The colour model is linear in RGB, so the shifted colour is
  `M(D) · rgb` with M tabulated over D once at load. Rejected: integrating a spectrum per pixel.
- **Brightness: a fixed exposure with a soft shoulder (chosen).** Real D³ to D⁴ would blow the view ahead to white and
  crush the view behind to black on an 8-bit screen. A tone curve that is the identity up to 0.8 and rolls off
  smoothly above keeps the physical ratios up to the shoulder. Rejected: hard clipping (ahead becomes flat white);
  automatic exposure (would hide the brightening it is meant to show).

## 4. Design

### 4.1 Directions (camera space)

Camera space: x along facing, y to the right (the camera plane), z down (rows grow downward). A frame pixel (col, row)
looks along `(1, (col + 0.5 − W/2) / proj, (row + 0.5 − H/2) / proj)`, normalised; the raycaster's pixels are square,
so one `proj` serves both axes. The velocity is horizontal: `v = (cos a, sin a, 0)` with `a` = `Motion.angle`.

**Inverse aberration** (where the light seen along n' came from, in the room's frame): with c' = n'·v,
`c = (c' − β) / (1 − β c')`, and n stays in the plane of n' and v:
`n = c·v + √(1 − c²) · (n' − c'·v) / |n' − c'·v|` (when n' ∥ v, n = n'). **Forward aberration** (for labels) is the same
with −β. Doppler: `D = 1 / (γ (1 − β c'))`, γ = 1/√(1 − β²).

### 4.2 Source frame

The source is planar, centred on the facing, with the same `proj` on both axes. When the look turns on or the frame
changes, `fit` finds the widest source angle needed: for β = MAX_BETA (0.5) and motion angles every 5°, it inversely
aberrates the frame's border pixels and takes the largest |n_y/n_x| and |n_z/n_x|, plus a 2% margin. The source FOV is
from the first and its height from the second; its width stays `SOURCE_WIDTH_FACTOR` (2) × the frame's. For 640×360 at
66°: about 132° wide, 1280×492. Built once per fit, never per frame (AGENTS rule).

### 4.3 The remap grid

Grid points every `GRID_PX = 8` pixels across the frame, plus the far edges (81×46 points for 640×360). Per point,
when the motion changes (`aim`): the source x, source y (pixels, fractional) and the Doppler factor's table index.
`apply`, per pixel: bilinear between its cell's four corners for source x, y and the D index (fixed point is fine);
nearest source pixel; colour through §4.4. At β = 0 the grid is the identity onto the source's middle.

`readFrom` / `readTo` (source columns the frame reads, for the main pass and seen faces, D39 review) come from the
grid's min and max source x, widened by one column. The output `zbuffer` takes, per column, the source column read at
the eye row.

### 4.4 Colour

Pixels are sRGB bytes; light is shifted in linear light. Tables built once: `SRGB_TO_LINEAR` (256 floats),
`LINEAR_TO_SRGB` over the tone curve's output (4096 steps).

The spectral model (`renderer/spectrum.ts`):
- Three basis spectra, one per channel, Gaussian in wavelength: blue 450 nm, green 540 nm, red 610 nm, σ 35 nm. The
  room is lit by warm lamps, rich in infrared and poor in ultraviolet, and most paints reflect infrared about as much
  as they reflect light overall: every basis carries the same infrared tail past 700 nm, `IR_TAIL / 3` times a
  half-Gaussian of σ 300 nm (`IR_TAIL = 0.6`), so a colour's infrared follows its brightness, whatever its hue. No basis
  reaches below 400 nm: there is no ultraviolet.
- The eye's sensitivities: the same three Gaussians without tails.
- For a factor D, observed channel i = `D⁵ ∫ sens_i(λ) S(λ·D) dλ` (spectral radiance per wavelength goes as D⁵;
  bolometric D⁴), over 300–1500 nm in 2 nm steps. Linear in the source RGB, so `A(D)_ij = D⁵ ∫ sens_i(λ) B_j(λ·D) dλ`
  and `M(D) = A(1)⁻¹ A(D)`, so M(1) = I.
- Tabulated at `DOPPLER_STEPS = 256` values of ln D, evenly over [ln 0.5, ln 2] (β = 0.5 needs 0.577–1.732).

Per pixel: `rgb_lin = SRGB_TO_LINEAR[byte]`, `out = M(D) · rgb_lin`, each channel through the tone curve, then
`LINEAR_TO_SRGB`. Tone curve: `t(x) = x` for x ≤ 0.8, above it `0.8 + 0.2 · (1 − e^{−(x − 0.8)/0.2})`, so it reaches
1 asymptotically. Negative channels (a matrix can produce them) clamp to 0.

What this shows at β = 0.5: ahead, D ≈ 1.7, the eye sees the room's infrared shifted into view and brightened by D⁵:
a pale blue-white glare toward the motion, everything in it as bright as it is overall, whatever its hue. Behind,
D ≈ 0.58, the visible comes from ultraviolet the room doesn't have: it goes black. Beside (D ≈ 0.87), colours slide
toward red and dim. Walking (β = 0.25: 0.77–1.29) shows the same pattern gently.

### 4.5 Labels

A label is projected in the source frame as today, then its direction is forward-aberrated (§4.1) and projected into
the frame; its size is scaled by the ratio of output to source solid angle along that direction (proj_o / proj_s times
the change in `1/n_x`, the builder may use the local grid scale). Off the frame: not drawn.

### 4.6 Unchanged

Settings, console, β cap, own motion, light delay (`seenAt`, trails), the main pass limited to `readFrom..readTo`,
first-person items drawn after `apply`. `tintOf`, `sourceAngle`, `dopplerFactor` (the D39 forms) are replaced.

## 5. Tests (first)

- Aberration: β = 0 is the identity; inverse then forward returns the direction; the motion direction is fixed;
  directions crowd toward it (angle to v shrinks seen, so the source angle is larger); a vertical line off the motion
  axis maps to a curve (its source x varies with row).
- Doppler: 1 at rest; at β = 0.5 ahead 1.732, behind 0.577, side-on (c' = 0) 0.866.
- Spectrum: M(1) = I; grey brightens ahead (D = 1.5) and darkens behind (D = 0.6); ahead, a pure-blue source still
  shows (from its infrared) and its light turns toward blue-white; behind, every source is darker than at rest; a
  colour sliding toward red beside (D = 0.87): green loses to red; tables finite, channels non-negative after clamping.
- Tone curve: identity to 0.8, monotonic, below 1.
- Source fit: the source covers every grid point's source pixel at β = 0.5, every motion direction, for 640×360 at
  `FOV_WIDE` and a portrait touch frame at `FOV_TALL`; built once per frame size.
- Grid: at β = 0 a flat source is copied unchanged; bilinear source positions match the exact map within half a
  pixel at cell centres at β = 0.5.
- Frame: the look off keeps every hash; through a bend first-person items are unbent; only shown faces count as seen.

## 6. Left to the builder

Fixed-point vs float in the per-pixel loop; exact integration step; the label size approximation; where the colour
tables live; grid edge handling.
