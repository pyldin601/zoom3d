# Voxel shadows and floor mirror: design spec

Status: approved design, implemented 2026-10-23. Decision record: [open-decisions.md](../../open-decisions.md) D24.

Calls marked **(my call)** were made by the designer, not the product owner, and can be overridden.

## 1. Intent

The voxel objects (the robot vacuum and the ball) should sit in the lamp-lit room the way walls do. Each lamp near an
object casts a faint shadow away from that lamp, with soft edges like the walls' baked shadows. The object also shows
up mirrored in the shiny floor below it, as soft as the floor's lamp reflections. Today an object gets a round
avatar-style shadow under it, whatever the lamps do, and the floor reflects only the lamps.

### Goals

- **Lamp shadows.** Every lamp that lights the floor near an object casts that object's shadow on the floor, pointing
  away from the lamp. It's longer the lower and farther off the lamp is. Two lamps make two faint shadows.
- **Soft edges like the walls'.** The lamp is the same 0.18-tile disc the bake uses (`LAMP_RADIUS`), so penumbrae
  match the walls' baked shadows. The shadow lives on the same 1/8-tile floor cells (`FLOOR_SUB`).
- **Shadows block the floor's lamp reflections**, as wall shadows already do.
- **Floor mirror.** Each object is drawn upside down under the floor. It's blurred to match the softness of the lamp
  reflections, kept faint, and fades with distance like the floor's reflections (`REFLECTION_RANGE`).
- **The round shadow goes** from voxel objects (product owner: "no need in contact shadows anymore").

### Non-goals

- **Shadows where no lamp reaches.** In rooms without lamps, and in the unlit renderer mode, objects get no shadow at
  all (product owner: "let em float").
- **Highlights on the objects' faces.** "Reflect light" meant the floor mirror; faces keep today's per-direction
  lighting **(my call)**, from the product owner's clarification.
- **Shadows on walls, the ceiling, people or other objects.** A shadow lies on the floor only and stops at a wall's
  base. The ball (0.4 tall) can throw one up to about 4 tiles from a lamp near the edge of its reach, but that far out
  the lamp barely lights the floor, so the cut is faint; no length cap (product owner accepted this).
- **Avatars.** People keep their round shadow, cast no lamp shadows and don't show in the floor mirror.
- **Objects in the ceiling's ping-pong reflection, or mirrored in walls.**
- **Lamp light blocked on other objects** (the ball in the vacuum's shadow stays lit).

### Anti-goals (a failure even if it works)

- A crisp, mirror-sharp copy of the object in the floor. It must read as a soft sheen, matching how blurry the lamp
  reflections on the floor are.
- Shadow edges that look different from the walls' (hard polygons, a different grain, bands that don't match).
- Dropping frames: no allocations per frame, and the cost stays small next to today's ~1.3 ms lit frame.
- A visible jump when an object crosses a lamp's reach. Shadows fade with the lamp's light, so they can't pop.

## 2. Approaches

### Floor mirror

- **A. Draw the object again, flipped under the floor, blurred (chosen).** Project each face with z → −z into a small
  scratch buffer the size of the mirror's on-screen box. Box-blur it, then mix it into the floor pixels there. The cost
  scales with how big the object looks on screen.
- B. Reflect the view ray at every floor pixel and test it against the objects. It's exact, but far too slow per frame.

The product owner picked A.

### Lamp shadows

- **A. Darken the floor cells per frame (chosen).** Each frame, for the floor cells an object can shade, work out how
  much of each nearby lamp's disc the object hides. Take that lamp's share of light out of the cell, and scale the
  cell's `floorLampSeen` for that lamp by the same amount, so reflections fall into the shadow. It goes down the same
  path the avatar glow already uses (patched copies of the baked floor tables, put back next frame).
- B. Cast the object's outline from points across the lamp as dark polygons on screen. It's cheaper to write, but it
  doesn't block reflections, and its banded edges wouldn't match the walls' shadows.

The product owner picked A, for both.

## 3. Design

### 3.1 Where it runs

Today `renderWalls` draws walls, floor, ceiling and floor reflections; `renderSprites` then draws shadows, people and
objects. Both features work on the floor, so both happen in the walls pass, before anything is drawn over the floor:

1. Patch the floor tables with object shadows (and avatar glow, as today) → draw floor and ceiling.
2. Floor and ceiling lamp reflections, reading the patched `floorLampSeen`.
3. **New:** the objects' floor mirror, mixed into floor pixels.
4. `renderSprites` as today, minus `drawVoxelShadows`.

So `renderWalls` needs the objects: `Room` (or the lit path's input) gains `objects: readonly VoxelInstance[]`.
`RoomScene` already has them through `PeopleAndObjects`, and so does the landing scene's room, so the landing vacuum
gets shadows and a mirror for free.

### 3.2 Lamp shadows

**Which cells, which lamps.** For each object and each lamp whose light reaches the object (`falloff` > 0 at the
object, with line of sight), the shadow falls on the floor within the object's footprint grown away from the lamp. A
point at height `h` with the lamp at horizontal distance `d` and height `lz` throws its shadow out to `d · h / (lz − h)`
from the object. With corridor lamps at 0.85 and a reach of 4.5, that's at most about 1.4 tiles for the vacuum and 4 for the ball. Only
cells inside that bound, inside the lamp's reach, and in view (`outOfView`, as the glow uses) are tested.

**How much of the lamp a cell sees past the object.** The object's shape, seen from above, is a height field: per
voxel column in model space, the top of its highest filled voxel. `buildModel` derives it once per model and keeps it
on `VoxelModel`, replacing `shadowRadius`. For a floor cell and a lamp, trace sight lines from the cell's centre to N
points across the lamp's disc (the line across the sight line, `±LAMP_RADIUS`, as `seenShare` does). Each one is
blocked if, in the object's rotated model space, it passes under the column height over any column it crosses. The
cell's seen share is the fraction left unblocked. Unlike `seenShare`, the samples cover the lamp's whole disc in 2D,
not only the line across the sight line: a low object's far tip is softened by the lamp's extent along the sight line,
which a wall never needs **(my call)**. N and the stepping are the builder's (see §5), as long as the penumbra reads
as smooth as the walls'. Where a lamp is missing from a cell's baked lamp list (8 slots), its baked seen share is
recomputed with `seenShare`.

**Taking the light out.** The baked floor cell is `tint(FLOOR, ambient + Σ lamp · kf)`, with
`kf = falloff(df, radius) · (lz / df) · seen`. For each shadowed cell, recompute that lamp's `kf` from the bake's
formula and the cell's baked `floorLampSeen` for it. The cell then loses `FLOOR · lamp · kf · (1 − objectSeen)` per
channel. Where the baked cell was clamped at 255 near a lamp, the result is slightly off, which is acceptable. With
two objects or two lamps on one cell, the losses add, and each lamp's object share multiplies (the share for lamp `l`
is the product over objects).

**Reflections.** In the per-frame copy of `floorLampSeen`, the cell's entry for that lamp is scaled by `objectSeen`.
`addRowReflection` reads the patched copy for the floor, so the reflection is cut along the same edge. The ceiling's
ping-pong reflection keeps reading the baked table, since objects stay out of it.

**With the avatar glow.** Shadows go in first, then the glow takes the brighter of itself and the shadowed light
(`withGlow`, unchanged). A glowing avatar standing in an object's shadow still lights it. One set of patched tables
serves both, with one dirty list, so a frame with neither costs nothing beyond today's.

**When it applies.** Only in lit rooms with the lamps on (not the `'only'` reflections-on-black mode, where there's no
floor light to take away), whatever the reflection mode. The unlit mode draws no voxel shadow at all.

### 3.3 Floor mirror

**Geometry.** The same faces as `renderVoxel`, each corner's z negated, with the back-face test done against the
mirrored normal.

**Bottom faces.** `buildModel` drops downward faces today, because the eye (0.5) is always above the objects (vacuum
0.2, ball 0.4) and can never see one. The mirror sees the objects from below, so without them the ball's lower half
would show as holes. `buildModel` gains a sixth face direction, the bottom (lighting.ts `DIR_BOTTOM`), built like the
other five (product owner: "just add missing sides"). The normal view never sees them: its turned-away test already
skips them. They're lit by the same rule as every face: `directLight` gives them no lamp light (lamps hang above), so
they get ambient times their flat shade, and their shine, and read a little darker, like a real underside **(my
call)**. The ball's recolouring covers them like any face. Faces are drawn in the object's
lit colours, the ones `litColor` gives it this frame, so a dark corner's ball still glows green in the mirror.

**Where it lands.** Each face is depth-tested per column against the z-buffer like the object, and drawn only on floor
pixels (rows at or below the wall's end, `wallEnd`). The faces go into a scratch RGBA buffer cleared over the mirror's
on-screen box only, with coverage, so the blur softens the outline into the floor rather than into black.

**Blur.** A separable box blur over the box, its radius set in tiles and turned into pixels by the object's depth
(`proj · radius / depth`), so a far object isn't smeared into a blob. The starting radius is the builder's; the product
owner tunes it by eye against the lamp reflections' softness (see §5).

**It hides the lamps' reflections behind it** (amended 2026-10-23, product owner: "I would expect to see a dark blurry
ball in reflection under the real one"). In the floor an object's image stands in front of the lamps' images, so
under it the floor's lamp reflections are hidden by its blurred coverage: an unlit ball shows as a dark, blurry ball in
a lamp's streak. Each object's blurred image is merged, far to near, into one frame layer before the floor
reflections are added; they are scaled by `1 − coverage`, and then the layer's own colour is added at
`MIRROR_STRENGTH` (0.3, walls.ts), so a lit ball also shows as a faint lit ball. The ceiling's reflection is unchanged.
This replaces the mix below.

**Strength (superseded by the paragraph above).** The blurred mirror is mixed over the floor at the floor's reflectance: a constant share (the
`FLOOR_MATERIAL` f0, 0.1, with a shallow-angle boost like `specular`'s if it reads better), times the distance fade
`1 − (d / REFLECTION_RANGE)²` from the eye. Mixed in OKLab or plain RGB, as the builder finds cheaper with no visible
difference **(my call)**.

**When it applies.** Whenever the floor shows reflections: modes `'both'` and `'only'`. Not for `'none'` or
`'walls'`, and not in the unlit mode. In `'only'` it's drawn on black, like the rest of the reflections.

### 3.4 Removed

- `drawVoxelShadows` in `sprites.ts` and `VoxelModel.shadowRadius` (with its tests). The ball spec's "banded floor
  shadow like avatars" line and the vacuum spec's §6.4 shadow note get a pointer to this spec.

## 4. Tests and proof

- **Unit tests first** (vitest, `voxels.test.ts` / `walls.test.ts` / `lighting.test.ts`):
  - The height field from `buildModel`: a known grid gives known column heights.
  - Shadow share: a cell right behind an object from a lamp sees less of it; a cell on the lamp's side sees all of it;
    a cell beyond the shadow's length sees all of it; the penumbra is monotonic across the edge.
  - The shadow points away from the lamp: with a lamp to the east, cells to the west darken and cells to the east don't.
  - The floor colour drops by the lamp's share, and `floorLampSeen` for that lamp scales by it; other lamps untouched.
  - Tables are put back the next frame when the object moves away.
  - The mirror: a lit frame with an object has changed floor pixels below it and none above the horizon or on walls;
    with reflections `'none'` the frame matches one drawn without the mirror.
  - No voxel shadow in the unlit mode or where no lamp reaches (the frame matches one without the object, below it).
- **Perf:** `pnpm bench:sprites` and `pnpm bench:walls` before and after, recorded in D24's cost list. Target: a few
  tenths of a millisecond at most for the vacuum and ball in view at 640×360.
- **By eye:** the product owner plays it locally and tunes the mirror's blur and strength and the shadow darkness.

## 5. Left to the builder

- The number of disc samples per lamp and the sight-line stepping through the height field, provided penumbrae read
  smooth and the cost stays within the target. Reusing `seenShare`'s halving approach is fine if it fits.
- The mirror blur's starting radius, and whether two box passes are needed for a softer falloff.
- A tunable constant for shadow darkness, in case the product owner wants them fainter than physical.
- Whether shadows and glow share the existing `glowTables` structure or a renamed one (it now patches more than glow).
- Where the mirror code lives (`voxels.ts`, with `walls.ts` handing it `wallEnd`, or a new `renderer/mirror.ts`).
- Decision record: add the result to D24 (Lighting) in `docs/open-decisions.md` and update AGENTS.md's world-objects
  drawing note.
