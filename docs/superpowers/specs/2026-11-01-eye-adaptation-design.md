# Eye adaptation — design spec

Date: 2026-11-01. Status: approved and built (D32). A small change, so this is the short design.

## Intent

A lit room has bright places, under its lamps, and dim ones. Walking from one into the other should feel like eyes
adjusting. The first look into a dim corridor is dark, and it brightens over a second or two. Stepping into a bright
place first looks too bright, then settles. The owner wants this to be the cheap kind (2026-11-01). It isn't about
supporting HDR displays.

- **Goals:**
  - The frame's overall brightness adapts slowly to what the eye sees.
  - In ordinary places the room looks as it does today.
- **Non-goals:**
  - Bringing back detail in bright areas. Every pixel is already clipped to 0–255 when it is written, so adapting
    down only greys the clipped parts. Doing that properly needs exposure inside every lighting path, before the
    clamp. That is a project of its own, worth it only if this one shows the greying is a problem.
  - Bloom and glare.
- **Anti-goals:**
  - A frame cost over about 0.5 ms.
  - Allocations per frame.
  - Brightening the portal blackout (D30) back up.
  - Pumping: the brightness must not flicker as the player turns past a lamp.

## Approaches

1. **One step after the frame is drawn (chosen, 2026-11-01).** Measure the finished frame, adapt slowly, then scale
   every pixel through a 256-entry table. One extra pass, touching nothing else. Bright areas only grey when it adapts
   down.
2. **Exposure inside the lighting**, before every clamp: walls, floor and ceiling, glows, sprites, voxels, the mirror
   and the windows. It looks right both ways, but it touches every fast path and every benchmark proof.
3. **Exposure from the room's baked light at the player's spot, not from the frame.** Cheaper still and never pumps,
   but it ignores where the player looks: looking from a dark spot out into a lit hall wouldn't change anything.

## How it works

- **Where:** `renderView` runs it after the main pass and the windows, and before the first-person hands. The hands
  stay as they are now and aren't counted in the measurement. Labels and the automap are on the HUD canvas, so they're
  untouched.
- **Measure:** the mean brightness (`luma`) of a sparse grid of the frame's pixels, about one in 64, weighted towards
  the centre *(our call)*. It's averaged in log space, so a lamp in view doesn't swamp it.
- **Adapt:** the eye's level moves towards the measurement exponentially, faster into light (about 0.3 s) than into
  the dark (about 1.5 s), as eyes do. It runs on real time, so the frame rate doesn't matter.
- **Gain:** `(reference / level) ^ strength`, clamped to [`GAIN_MIN`, `GAIN_MAX`].
  - `reference` is the level of an ordinary lit spot, so the gain there is 1 and the room looks as it does today.
    The builder takes it from `bench:walls`' lamp poses.
  - `strength` under 1 adapts only part of the way, as eyes do *(our call: 0.5 to start)*.
  - `GAIN_MAX` is about 2.5: past that, the few dark shades show as bands.
  - All of these are starting values, to be tuned by playing.
- **Apply:** a 256-entry table per frame, rebuilt only when the gain moves by more than a small step. One pass over the
  640×360 frame, with no allocations.
- **Off:**
  - In unlit rooms (`?lights=off`, or flat mode) it isn't run.
  - While the room is dark in a portal sequence, the eye's level is frozen and adapts again after.
  - Its state is reset (gain 1) when the room changes, so joining a room doesn't start mid-adaptation.
- **Benchmarks:** the existing `bench:walls` and `bench:sprites` hashes stay as they are, since the step sits outside
  their passes. A new bench line measures its cost.

## Testing

- **Failing tests first** for the pure parts:
  - the measurement (a uniform frame, a bright centre against a bright edge);
  - the adaptation (direction and the two speeds, independent of the frame rate);
  - the gain curve and its clamps;
  - the table: gain 1 changes no pixel.
- **By hand:** walk between a lamp and a dim corner in a local room, then tune the numbers.
- **Docs:** record D32 in `docs/open-decisions.md`, and add a line to AGENTS.md gotchas.

## Left to the builder

The module's name and exactly where it lives, the sample grid, the centre weighting, `reference`, and the step at
which the table is rebuilt.
