# Ray-traced lighting (a second renderer): design spec

Status: approved design, implemented 2026-10-17, from a brainstorm and an approved throwaway spike
(`spikes/raytrace/`, committed as a throwaway reference).
Decision record to add: [open-decisions.md](../../open-decisions.md) D25.

Calls marked **(my call)** were made by the designer, not by the product owner, and can be overridden. Everything else
was decided by the product owner, most of it by looking at the spike on a phone and asking for changes.

## 1. Intent

Today's lighting (D24) is a stack of hand-built tricks, each fixing the last one's artifacts: baked 2D sight lines, a
disc-share search for soft shadows, 40 rounds of blur for bounce light, Blinn-Phong reflections that need per-cell
lamp lists, 17 heights per column, a near-wall fade, a ceiling that mirrors the floor's lamps, and an OKLab colour mix.
The owner wants the light to follow from **a few simple, roughly true rules** instead: light leaves the lamps, travels
in straight lines, is blocked by walls and bounces off surfaces by their material. Shadows, reflections and bounce light
should fall out of those rules rather than each having its own code.

The new renderer is built **next to** the current one and **switchable** at runtime. Whether it ever replaces the
current one is decided later, after living with it.

### Why it is cheap here

The world is 2.5D: every wall is full height, the floor is at z = 0 and the ceiling at z = 1. A 3D ray is blocked
exactly where its 2D path enters a wall cell, so **every ray is a 2D grid walk plus a height check**. A ray mirrored
off a wall keeps one 2D direction for a whole screen column (one extra walk per column), and a ray mirrored off the
floor keeps the column's own direction (no extra walk). Only heights differ per pixel, and they are arithmetic.

### Goals

- A new choice in the console's **Lighting** menu, "Ray traced", saved per browser like the other render settings,
  and a **Lighting button in the touch tray** so phones can switch too (the console only opens with a key).
- **Smooth on phones from the start.** The spike ran "perfect" on the owner's phone at 640 px wide, with ½-res
  reflections.
- **People show up in reflections**: faces in the floor and in glossy walls, sharp where the surface is glossy, a soft
  blob of their colours where it's rough.
- The **look the owner approved** in the spike (section 3): warm like the current renderer, a satin floor, golden
  sheen on wood, the original ceiling lamps.
- **Pure rays.** All light comes from the lamps along rays: no base light, and surfaces bounce what their real (linear)
  colour bounces. The owner chose this over the spike's softer look (section 3.4).

### Non-goals

- Deleting or changing the current renderer or its tricks. The two live side by side.
- A GPU path (WebGL/WebGPU). It stays a CPU renderer into the same `Framebuffer`.
- Moving lights: people casting shadows, faces lighting the room (today's avatar glow) in this mode, the vacuum lighting
  anything. Faces still look like screens; they just don't light their surroundings yet **(my call)**.
- Brick relief (today's lamp-lit brick edges): the approved spike had none.
- Lamps of their own in rooms (still "not done yet" in D24), or any change to where lamps are placed.
- The landing page: it keeps the current renderer **(my call)**.

### Anti-goals (a failure even if it works)

- Frame drops on phones, or per-frame allocations in the hot path.
- Reflections with box, rectangle or square shapes (the spike's first try blurred on screen and the owner saw them).
- Highlights bleached to white, or light that reads cold next to the current renderer.
- Any change to the current renderer's pixels: `pnpm bench:walls` hashes stay identical.

## 2. How it plugs in

- **Mode.** `RenderMode` (`ui/render-settings.ts`) gains `'traced'`, with a name in `MODE_NAMES` (`ui/audio-panel.ts`).
  The default stays `'reflections'` (today's look) **(my call)**: the owner said the renderers are switchable, not which
  is default. `?lights=off` still means the flat, unlit room in every mode.
- **Touch tray.** The ⋯ tray (`ui/touch-controls.ts`) gets a Lighting button next to drinks, Boombox and Map. A tap
  steps to the next mode in the console's order and the button shows the current mode's name **(my call** on stepping
  rather than a list**)**; it saves the same setting the console does. Covered by `e2e/mobile.spec.ts`.
- **Frame.** `renderView` (`renderer/frame.ts`) calls the traced renderer **instead of `renderWalls`** when the mode is
  traced. It fills `fb.pixels` and `fb.zbuffer` exactly as `renderWalls` does, so `renderSprites`, the own held item and
  boombox, labels and the automap run unchanged after it. Avatars stay drawn by `renderSprites`, unlit, as today.
- **People in reflections.** The traced renderer reads the same scene sprites (position, face texels or ring colour,
  bob) to put people into reflections; it does not draw them in the direct view.
- **Floor shadows** under avatars keep darkening the finished pixels as today.
- **The vacuum** (voxels) must look lit consistently with the traced room: warm, dimmer away from lamps, its glowing
  parts unchanged. How (an adapter that answers `directLight`/`ambientAt` from the traced bake, or something simpler)
  is the builder's choice.
- **Bake timing.** Like today's bake, it runs on the room's first frame that needs it, but it takes longer (0.8 s on a
  Mac in the spike; phones unmeasured). It runs **a slice per frame** (a generator, about 6 ms per frame), and until it
  finishes the current lit renderer draws the room **(my call)**, so nobody sees a half-lit room. If phones stutter
  while it bakes, it moves to a Web Worker (the owner's fallback, section 4).
- **Code layout (my call).** `apps/web/src/renderer/traced/`: the ray walk, the bake, the frame, tone mapping. It reuses
  `castRay` (shared), `corridorLights`, `makeTextures`, `GLOSS` and the `Framebuffer`.

## 3. The look (approved in the spike)

### 3.1 Lamps and direct light

- A lamp is the game's fixture: a **glowing disc flush in the ceiling**, radius 0.18 tiles, shining down. The owner
  rejected lamps as hanging balls. Positions are `corridorLights(map)` as today.
- Disc radiance 36 × tint `(1, 0.84^2.2, 0.6^2.2)`: today's `LAMP` colour (1.25, 1.05, 0.75) as a ratio, converted to
  linear light. Without the `^2.2` the same warmth reads cold on screen (the current renderer tints screen colours).
- Irradiance from a lamp: `radiance × r² × cos(surface) × cos(disc) / d²`, faded smoothly to nothing by 8 tiles.
- **Soft shadows:** 2D shadow rays to strips across the disc. Rays to its centre and both edges first; only where they
  disagree, 8 strips weighted by their chord length.
- The ceiling gets no direct light (the disc faces down); it is lit by bounce only. It is painted light grey 0xa0
  (linear 0.352) in the traced room, where the current renderer's is 0x38 (owner's review, 2026-10-17): at 0x38 it
  showed about 90× darker than the floor under a lamp half a tile away, and neither it nor its reflection read. At
  0xa0 that is about 10×, so it stays dim.
- Lamps appear in the direct view as part of the ceiling (a point inside a disc shows the lamp's radiance).

### 3.2 The bake

- Light samples: floor and ceiling **8 per tile side**, blended bilinearly when drawn; walls **8 across each face × 3
  heights** (floor, middle, ceiling), blended linearly up the wall. Three heights was the owner's idea; 8 showed no
  visible difference in the spike and baked slower.
- **Bounce:** 3 passes of 16 cosine-weighted rays per sample, each bringing back the light at its hit times that
  surface's linear colour (the texture's average for walls). A 3×3 average over open floor and ceiling samples takes
  out the noise.
- A ceiling hit inside a lamp disc brings back nothing (its light is the direct part).
- Floor and ceiling samples inside wall cells take their open neighbours' light, so blending near walls never pulls in
  black.
- A **soft copy** of the floor and ceiling light (box-averaged over half a tile, twice) for wide reflection cones.

### 3.3 Reflections

- Materials (index = tile id, 0 = floor). `f0` is 0.04 for all; Fresnel is Schlick's, held down on rough surfaces
  (`f0 + (max(1 − roughness, f0) − f0)(1 − cos)^5`). Mortar never reflects (`GLOSS`). The ceiling is matte.

  | Surface | Roughness | Tint |
  |---|---|---|
  | Floor | 0.6 (satin) | 0 |
  | Stone brick | 0.85 | 0.6 |
  | Wood | 0.35 (semi-gloss) | 0.75 |
  | Blue brick | 0.85 | 0.85 |

  Tint is how much a reflection takes on the surface's own colour (its average albedo at full brightness): wood glows
  golden, blue brick shines bluish. It matches what the current renderer does with its per-material tint.
- **A rough surface reflects a cone, not a ray.** The cone is roughness² wide per tile travelled. By mirror geometry
  it keeps that width within the plane of incidence and narrows by the slant across it (slant floored at 0.1): a
  microfacet tilted by δ within that plane turns the reflected ray by 2δ at any angle, tilted across it by only
  2δ × slant. Off the floor the cone keeps its width up the screen and narrows sideways; off a wall it keeps its width
  across the screen and narrows up it. Its width up the screen, reaching the ceiling at a low rise, is what turns a lamp
  into a streak along a glossy floor (owner's review, 2026-10-17: the first build stretched by 1 / slant instead, which
  spread a lamp's floor reflection over about 10× too much floor).
- People meet the cone in closed form, as a Gaussian blob (the disc blurred by the cone, as bright overall as the
  disc). While the cone is narrower than 0.3 of a disc's radius the face is shown sharp, with its texture.
- A lamp meets it where the cone reaches the ceiling: the disc against the cone's footprint there, stretched along the
  ray by 1 / rise.
- Walls, floor and ceiling seen in a reflection lose detail as the cone widens: the texture fades to its average colour
  by 0.25 tiles of cone width, the floor and ceiling light to its soft copy by 1 tile. Where the cone straddles an edge
  (a wall's top or foot) the two sides blend over its width.
- **No screen-space blur.** Reflections are traced at ½ resolution (¼ only as the phone fallback, section 4) and
  blended up bilinearly. On very rough walls (roughness² > 0.25) every 4th row is traced and the rows between blended.

### 3.4 Exposure, tone and pure rays

- Exposure 4. Toning keeps hue: the brightest channel goes through `1 − e^−x`, the other channels scale with it. Only
  far past white (x from 3 to 30) does a colour fade towards white, up to 75%, so lamps read warm-white and highlights
  stay coloured. Then sRGB encoding.
- **Pure rays (the owner's choice, 2026-10-17).** The spike the owner first approved had two softeners: a base light
  of 0.03 everywhere and bounce at the texture's painted colour (2–5× its linear colour). The owner asked whether these
  were fake ambient light and chose to drop both. So the room is darker and more contrasty than the current renderer:
  between lamps walls are dim, the ceiling is dim, and **rooms without lamps are black**. A higher exposure barely
  lifts this (unlit areas are about 50× darker than lamp pools). The prototype was switched to pure rays for the owner
  to see on the phone before building.

## 4. Budget and verification

- Spike cost at 640×360 in Chrome on a Mac: about **4.7 ms** a frame with ¼-res reflections and **7.9 ms** with ½-res,
  in a wall-heavy view; the current renderer is about 1.3–1.7 ms. Bake 0.6 s. The owner's phone ran it smoothly.
- **Built, measured** (`pnpm bench:traced`, Node, 640×360, 2026-10-17, three runs): the cold bake takes 0.58–0.61 s;
  its first slice (10 ms) builds the world and no later slice runs past 7.5 ms, so a frame spends the 6 ms budget plus
  at most one slice. A frame costs **5.3–5.5 ms** alone and **5.6–5.7 ms** with the 100-person crowd (people in the
  reflections); `bench:walls` draws the lit room at 1.1 ms (1.8 ms with its crowd). In Chrome with no one else in the
  room the backtick panel reads 5.5 ms (33% of a frame) in this mode and 2.6 ms in the default one. Run alone,
  `frame-rate.spec.ts` measures a 16.7 ms median in both modes with a peer on video; in a full parallel run on a loaded
  machine the traced one has slipped to 33 ms.
- Reflection resolution: **½ everywhere**, the setting the owner's phone ran smoothly, with no menu choice **(my
  call)**.
- The spike listed every person and lamp along every column's ray (cheap with 7 people and 37 lamps). It must hold with
  a **100-person crowd** (`?bots=100`); how to cull is the builder's.
- **Tests first** for the logic: the ray walk (wall hits, floor and ceiling crossings, faces), direct light (≈1 under a
  lamp, 0 behind a wall, a monotonic penumbra at a doorway), bounce (a lit wall tints the floor in front of it), the
  cone blob (its total stays the disc's, it widens with distance), Fresnel, and the tone curve (hue kept, monotonic,
  never past 1). Rendering is checked with a bench and by eye.
- **Bench:** its own script (`bench:walls` folds every mode into one pixel hash, so a traced mode there would change it):
  bake time, ms per frame with the crowd, and its own pixel hash for later refactors. `pnpm bench:walls` output stays
  byte-identical. As built it times ½ only: ¼ is the phone fallback below, `REFLECTION_SCALE` is a module constant that
  the hot loops read, and a setter just to time a fallback that may never be used would put a mutable global on those
  paths. If the phone check misses, make the scale a parameter then and time ¼ (the spike measured it: 4.7 ms against
  7.9 ms at ½).
- **Phones in a real room.** The spike's phone run had 7 emoji discs and no video, audio or bots. The bar **(my
  call)**: on the owner's phone, in a room with 8 people on video, the frame-rate meter (`game/frame-rate.ts`) stays
  "good" (55 fps) in the traced mode. This is checked with the owner early, as soon as the traced room draws in the
  game, before the polish.
- **If phones miss it (the owner's fallback):** touch devices drop to ¼-res reflections and the bake moves to a Web
  Worker; if that still misses, stop and decide with the owner before going further.
- E2E `frame-rate.spec.ts` should pass with the traced mode on as well.

## 5. Left to the builder

The module and function structure within the constraints above; how the bake is sliced (or put in a Worker); how
round things are culled per column; the vacuum's lighting adapter; how the traced mode shares the `Framebuffer` scratch;
test fixtures; whether the spike's code is ported or rewritten (it is untested throwaway code and should be treated as a
reference, not a source).

## 6. Decided by the owner after the review (2026-10-17)

- Phones switch with a Lighting button in the touch tray.
- The phone ran the spike smoothly at ½-res reflections, so ½ is the default everywhere.
- If phones can't hold the bar: ¼ res and a Worker bake, then decide together.
- Pure rays: no base light, no bounce boost.
