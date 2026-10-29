# Portal glow: pulsing windows and a hum

Date: 2026-10-29. Status: draft for review. Builds on D27 (portal doorways) and D28 (portal lamp light).

## 1. Intent

With portals on, a doorway seen from its front is a window onto another doorway's back side. Today the window shows
the far room so cleanly that the portal is easy to miss. This work makes each portal window glow and pulse, with a
soft hum, so a portal reads as a portal: something to notice, walk up to, and learn.

The look and sound were chosen by trying a throwaway sketch (2026-10-29), which settled every value in §2.

## 2. What it does

Everything here exists only while the room's portals are on, and only for portal doorways. With portals off, nothing
changes: same pixels, same sound.

### 2.1 The pulse

- **One pulse drives the glow and the hum:** `pulse = 1 − depth · (0.5 − 0.5 · sin(2π · rate · t))`.
  - `rate` is 0.8 pulses a second, and `depth` is 40%. So the pulse swings between 0.6 and 1.
  - The user asked for "less amplitude" than a full swing, and picked 40% in the sketch.
- **Each player runs it on their own clock** *(our call)*. Everyone sees and hears the same rhythm, but not exactly in
  step, and nothing goes over the wire.

### 2.2 The colour

- **One colour for every portal:** pink, linear (1.0, 0.42, 0.78), about `rgb(255, 107, 199)`.
- The user chose one colour over a colour per doorway.

### 2.3 The window: shimmer and rim (the user chose "both")

What's seen through a window is changed, and only that. The doorway's frame and the near side are untouched by this
part.

- **Shimmer:** every pixel shown through the window is pulled toward pink by
  `k = 0.08 + 0.1 · pulse + 0.05 · ripple` (half the sketch's, tuned by eye in the game on 2026-10-29), where `ripple = 0.5 + 0.5 · sin(row · 0.32 + col · 0.06 − t · 5.5)` (a
  slow wave rolling across the window). The pixel becomes `pixel · (1 − k) + pink · 0.9 · k`. The ripple's numbers
  are for a 320-pixel-wide frame; scale them to the real frame so the wave looks the same.
- **Rim:** pink is added near the window's edges, falling off with the distance to the nearest edge, as
  `exp(−edgePixels / 2.2) · (0.35 + 0.65 · pulse)`. The sketch measured that distance on a 320-pixel-wide frame, so
  scale it to the real frame's width.
  - The left and right edges are where the opening meets its walls.
  - The top and bottom edges are where the opening meets the floor and ceiling at the plane's depth.
- **A window seen through another window** gets the effect at each level, so a deeper window looks a little pinker.
  That is expected.

### 2.4 The spill: pink light in front of the doorway (the user chose option 2)

- **A pulsing pink light at each portal doorway**, lighting the floor, walls and ceiling around it. It works like
  avatar glow (`renderer/glow.ts`): per frame, short reach.
  - **Walls cast its shadows** *(amended 2026-10-29, the user's call)*. A floor cell, ceiling cell or wall sample is
    lit only as much as it sees the glow, the way lamps light things: soft edges across a disc of radius `LAMP_RADIUS`
    (`seenShare`). Why: a screenshot of a doorway in a recess showed the pink lighting the floor and the side face of
    the block beside it, which the walls should hide. Avatar glows still cast none: they move, and their reach is
    short.
  - A portal glow never moves, so its shadow is a fixed table: baked per portal with the room's portals-on lighting
    (`bakePortalLighting`, `Lighting.portalGlowSeen`), one share per floor cell within its reach. A wall sample looks
    it up just in front of the wall. An unlit room (`?lights=off`) has no table, and no glow light at all.
  - **People and objects are not lit by it** *(our call)*. Avatar glow doesn't light them either; the glow reaches
    only the walls (`findColumnGlows`) and the floor and ceiling tables (`addGlow`). Lighting sprites and voxels would
    be new work in their paths.
  - **The ceiling in front of a doorway goes a little pink too** *(our call)*. `addGlow` lights the ceiling as it
    lights the floor. The sketch lit only the floor and walls, but a soft pink ceiling over a glowing doorway reads
    naturally, and a floor-only path would be extra work.
- **It lights only the doorway's front side.** A point is lit only when `(point − c)·n < 0`, with `c` and `n` the
  portal's centre and front→back normal.
  - From behind, a doorway is ordinary, so no pink should hint at a window there.
  - Reusing plain avatar glow was rejected because it would leak a tile or so onto the back side.
- **It sits in front of the doorway**, at the height avatar glows use: 0.6 tiles in front of the plane, at
  `c − 0.6·n` *(our call)*.
  - Why: glow lights only surfaces that face it. At the plane itself, the wall faces either side of the opening, the
    door frame the user saw glow in the sketch, would point away from it and stay dark. 0.6 tiles out is just past
    those faces (they lie 0.5 tiles in front of the plane), so they face it and light up.
  - The cut stays at the doorway's plane, not at the light.
  - Its reach matches the sketch's 2.6 tiles.
  - Its strength scales with `0.25 + 0.75 · pulse`.
  - Its overall brightness is tuned by eye *(left to the builder, see §6)*; it should read as clearly as in the sketch,
    without washing out the doorway.
- **It shows wherever avatar glow shows:** through windows, in reflections and in the floor mirror.

### 2.5 The hum

- **One hum per portal doorway**, at a point just in front of the opening, on its front side.
- **It follows the same spatial rules as every other sound** (the user's request). It goes through
  `AudioEngine.attachNode`, like the vacuum's hum, so it gets:
  - distance gain and pan;
  - reverb;
  - muffling behind walls;
  - the apparent position through portals (D27 §2.6).

  It is silent behind the doorway, where the doorway is ordinary (amended 2026-10-29: the user asked that it not be
  heard from behind the portal, like the glow). Standing on or behind a doorway's plane fades its hum out.
- **Its sound, settled in the sketch:**
  - a 98 Hz sine at 20% level (the user turned the base down: "not 20% of volume" → 20%);
  - plus a triangle a fifth above (147 Hz) at 25% level;
  - through a low-pass filter around 1–2 kHz;
  - swelling with the pulse: its gain goes from `1 − depth` up to 1, in step with the glow.

  The user liked this exact mix. In the game the engine's own distance and muffle rules replace the sketch's
  "brighter when nearer" filter.
- **It stays under voices**, like the vacuum (`VACUUM_GAIN`). The exact level is tuned by ear *(left to the builder)*.
- **It starts when portals turn on and stops when they turn off**, with a short fade, never a click.

## 3. Goals, non-goals, anti-goals

**Goals:**
- With portals on, every portal window shimmers pink with a glowing rim, and the floor and frame in front pulse pink.
- Each portal hums softly from its front, following the room's spatial sound rules.

**Non-goals:**
- A colour or pitch per doorway, or a pulse synced between players.
- A touch control, or a setting to turn it off.
- The ray-traced spike renderer.

**Anti-goals (a failure even if it works):**
- Anything changes with portals off: the pixel hashes in `pnpm bench:walls` and `pnpm bench:sprites` must stay at
  their D28 values.
- Pink on a doorway's back side.
- A hum louder than voices, or one that clicks when it starts or stops.
- A noticeably slower frame with portals on. The window effects and the spill's side test are per pixel or per lit
  sample, and must not allocate.

## 4. Constraints

- **No allocations** in the per-frame or per-column path (AGENTS.md).
- **The glow change touches every place that uses glow light.** Plain avatar glows, those without a plane, must give
  exactly today's result.
- **Logic is test-first:**
  - the pulse function;
  - the shimmer and rim maths, as pure functions of pixel, pulse, edge distance and position;
  - the front-side cut of a glow;
  - the hum's start and stop with the portals flag.

  The look and sound are checked by playing, and by a bench pose in front of a doorway with portals on.
- **Record the decision** in `docs/open-decisions.md` as D29.

## 5. Approaches considered

- **Window effects:** applied where a window's rows are copied into the frame (`copyWindowRows` in
  `renderer/frame.ts`), which already knows each window's columns, rows and plane depth.
  - Gains: zero cost outside windows, and it works for nested windows.
  - The only sensible place; a separate post-pass would have to find the windows again.
- **Spill, option 1 (rejected):** reuse avatar glow as it is. Almost free, but it leaks onto the back side.
- **Spill, option 2 (chosen):** avatar glow with an optional front-side cut at a plane. Every glow-lit sample pays one
  extra side test, but only for portal glows.
- **Hum:** synthesised with Web Audio oscillators, through the existing spatial engine. No sound file, and its pitch
  and mix stay as the sketch had them.

## 6. Left to the builder

- **How a glow carries its cut,** for example an optional plane on `Glow`, and where portal glows join the frame's
  glow list (next to `avatarGlows.update`).
- **The spill's brightness and the hum's level,** tuned by eye and ear against the sketch.
- **Whether to keep a hum for every doorway** (level1 has 24, so 48 oscillators), or only for doorways in hearing
  range. Measure the audio cost and pick.
- **Where the pulse function lives** so the renderer and the audio share it, for example `packages/shared` or
  `apps/web/src/game`.
