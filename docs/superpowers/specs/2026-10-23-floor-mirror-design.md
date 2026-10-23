# Floor mirror: design spec

Status: approved design, implemented 2026-10-23 (blur at quarter resolution, its second cost fallback). Decision
record: [open-decisions.md](../../open-decisions.md) D24. Builds on [2026-10-23-voxel-shadows-and-mirror-design.md](2026-10-23-voxel-shadows-and-mirror-design.md)
§3.3, which mirrors only the voxel objects.

Calls marked **(my call)** were made by the designer, not the product owner, and can be overridden.

## 1. Intent

The shiny floor should reflect everything standing on it the same way: the walls and doors, the people, the ball and
the vacuum. Product owner: "the image should the same as the floor reflects everything in the same way". Today it
reflects only the lamps (streaks) and, since this morning, the voxel objects.

### Goals

- **Walls in the floor.** Under each wall's foot the floor shows the wall upside down: its texture and light as drawn,
  doors included.
- **People in the floor.** Each person's disc (face and ring) shows upside down under them.
- **One treatment for all of it.** Walls, people and objects go through the same mirror layer, the same blur, the same
  fade and the same strength. Nothing is reflected sharper or brighter than anything else.
- **Images hide the lamp streaks behind them**, as the ball's does now: where a person's or object's image covers the
  floor, the lamps' floor reflections are hidden by its coverage, then the image's own colour is added. Walls' images
  never hide a streak **(my call)**: the lamps hang inside the rooms, so in the floor every lamp's image stands in front
  of the wall behind it. Hiding them would also wipe out most streaks, since a wall's image covers the floor from the
  wall back to about a third of its distance.

### Non-goals

- The ceiling's reflection, and walls reflecting anything, stay as they are.
- Held drinks, boomboxes, name labels and shadows are not mirrored **(my call)**: they're small or flat, and the disc
  carries the person.
- No new reflection mode or switch. The mirror shows wherever floor reflections show (`both` and `only`), as the
  ball's does.

### Anti-goals

- Things reflected differently, such as walls sharp and the ball soft, or people brighter than walls.
- A crisp mirror. It stays a soft, faint sheen at the ball's current level: blur 0.06 tiles, colour added at 30%.
- A visible cost. The whole mirror, walls included, must stay within a few tenths of a millisecond at 640×360.
- Allocations per frame.

## 2. Approaches

- **A. Copy the drawn walls flipped, draw people and objects into the layer, then blur once (chosen).** In a
  raycaster each screen column shows one wall slice, from `wallStart` to `wallEnd`. The floor below it shows that
  slice mirrored about its foot: the floor row `wallEnd + k` shows the wall row `wallEnd − 1 − k`, until the image
  passes the wall's top. So the walls' image is read from the frame already drawn, with no new rays. One blur then runs
  over the whole floor area of the layer.
- B. Smear each wall column down its own column, with no shared blur. It's the cheapest, but walls would blur unlike
  people and objects.
- C. Bounce a ray off the floor at every floor pixel. It's exact, but far too slow.

The product owner picked A.

## 3. Design

### 3.1 The frame's order

Lit room with floor reflections on (`both`, `only`):

1. Walls, then floor and ceiling (object shadows patched in), as today.
2. **Build the mirror layer** for the frame:
   1. the walls' image, column by column from the drawn wall pixels;
   2. the people's and objects' images, far to near, depth-tested per column against the walls' z-buffer as their
      upright selves are (a nearer disc or object covers a farther one, and all of them cover the walls' image, since
      everything on the floor stands in front of the wall behind it);
   3. one blur over the layer.
3. Floor lamp reflections, scaled by `1 − coverage` on floor rows, as now.
4. The layer's colour added on floor rows at `MIRROR_STRENGTH` (0.3), as now.
5. `renderSprites` draws the people and objects upright, as today.

`renderWalls` already takes the objects; it now needs the people too. `RoomScene` carries both, and the landing scene
passes its people.

### 3.2 The walls' image

For a floor pixel in column `col`, row `y ≥ wallEnd[col]`: let `k = y − wallEnd[col]`. While `k < wallEnd − wallStart`
(the wall's height in pixels), its colour is the wall's pixel at row `wallEnd − 1 − k` with coverage 1. The view has no
pitch, so a wall is always drawn symmetric about the eye line: one clipped at the top is clipped at the bottom too,
and has no floor under it to mirror into. Past the wall's top, the floor shows the mirrored ceiling: no coverage, so the
lamp streaks stay **(my call)**. The ceiling is dark, and its lamps are already in the floor as streaks.

The wall pixels copied are the drawn ones: their baked light, relief, glow and wall reflections, so the image matches
the wall above it.

### 3.3 The people's images

A disc is centred at eye height, `EYE_HEIGHT` (0.5), lifted by the walking bob, radius `AVATAR_RADIUS`. Its image is the
same disc centred `EYE_HEIGHT + lift` under the floor, so on screen it sits below the disc's foot, with the face
texture read upside down. It's depth-tested per column like the disc, and drawn into the layer with coverage 1. Its colours are the disc's as
drawn, unlit: faces glow like screens (D24, avatar glow), so their images are as bright as the faces.

### 3.4 The objects' images

As today (`renderVoxelMirror`), except they no longer blur on their own. They're plotted into the shared layer, and
the shared blur softens them.

### 3.5 The blur

- **Its size, in tiles.** One radius, `MIRROR_BLUR` (0.06 tiles), turned into pixels per floor row by the row's floor
  distance: `proj · MIRROR_BLUR / rowDistance` **(my call)**. That's the floor point's distance, not the reflected
  thing's. A far row blurs less in pixels and a near row more, so everything at the same place on the floor blurs alike.
- **How it runs.** At half the frame's resolution, over the layer's floor rows only (the rows from the horizon down
  that any image covers), as a separable box blur that allows a different radius per row (running sums, or a summed
  table). Then it's read back at full resolution, with bilinear filtering or nearest **(my call; whichever looks
  smoother at no measurable cost)**. Colour stays premultiplied by coverage throughout, as today.

### 3.6 Two coverages

The layer keeps two coverages per pixel: what shows (walls, people and objects, used for the blur and the added
colour) and what hides the lamp streaks (people and objects only, see §1). Both are blurred alike.

### 3.7 Fade and strength

- The image fades out with the floor point's distance from the eye, `1 − (rowDistance / REFLECTION_RANGE)²` (the floor
  reflections' own fade), instead of with each object's distance **(my call; it keeps a far wall and a far ball alike)**.
- It hides the lamp streaks by its hiding coverage times that fade, and adds its colour at `MIRROR_STRENGTH` times
  that fade.
- Nothing is culled by its own distance any more: a ball 8.5 tiles off now shows faintly on the nearer floor its image
  falls on, as a wall that far does. The test "a far ball's mirror fades out" is rewritten to this rule (a ball far
  enough that its whole image lies past `REFLECTION_RANGE`).

### 3.8 Modes

The mirror shows in `both` and `only`, and not in `none`, `walls` or the unlit renderer. In `only` it's drawn over the
black floor, like the rest of that mode's reflections.

## 4. Tests and proof

- **Unit tests first:**
  - The walls' image: in a corridor with no lamps, the floor rows just under a wall's foot take the colour of the
    wall's bottom rows, with coverage 1. Past the wall's full height, coverage is 0.
  - A wall's image never hides a lamp streak: with no objects or people, the floor's streaks are unchanged by the
    mirror (only the image's colour is added).
  - A person's image appears under the disc, upside down: the face texture's top row lands lowest.
  - A ball in front of a wall covers the wall's image where they overlap.
  - The blur is wider in pixels on near rows than on far ones, and keeps total coverage per row.
  - The existing mirror tests still pass (the ball hides a far lamp's streak, no mirror in `none`/`walls`/unlit, a ball
    behind a pillar shows none), with "a far ball's mirror fades out" rewritten to §3.7's rule. Tests that compare a
    frame with and without an object now compare against a frame whose walls' image is there in both.
- **Perf:** `pnpm bench:walls` (it has no objects or people, so the walls' image alone) and `pnpm bench:sprites`
  before and after, on a quiet machine. Target: the whole floor mirror ≤ 0.4 ms at 640×360. If it's over, in this
  order **(my call)**: nearest read-back instead of bilinear, then a quarter-resolution blur, then the walls' image
  only within `REFLECTION_RANGE`; past those, report the cost to the product owner rather than cut further.
- **By eye:** the product owner plays it.

## 5. Left to the builder

- The blur's exact form (running sums or a summed table) and the half-resolution read-back, within the cost target.
- Where the code lives: `mirror.ts` for the layer and blur, `walls.ts` for the walls' copy, `sprites.ts` or
  `mirror.ts` for the discs.
- Updating the voxel spec §3.3, D24 and AGENTS.md (world objects → Drawing).
