# Lighter — design spec

Date: 2026-10-31. Status: approved and built (D31). Builds on D15 ([held items](2026-10-09-held-items-design.md)) and the
avatar glow (D24 follow-ups, `renderer/glow.ts`).

## 1. Intent

A player can hold a lit lighter. It throws a warm cone of light ahead of them, which walls block. Everyone in the room
sees the lighter in that player's hand and the light it throws. The user asked for the **cheapest** way to get this
(2026-10-31), so it is built from parts that already exist: the held-item slot and the avatar glow.

Goals:
- Key `9` holds the lighter. Others see it on the holder's disc, and the holder sees it in first person.
- The light is a cone along the holder's facing, lighting the floor, the ceiling, the walls and the voxel objects
  (the vacuum and the ball, and their images in the floor; added 2026-10-31 at the owner's request).
- Walls cast shadows: the light does not pass through them or round corners.

Non-goals (left for later, each a project of its own):
- **Reflections.** The lighter makes none on the walls, the floor or the ceiling. The walls' glints and streaks use
  lists per column that are calculated in advance (D24). The floor would be cheap: one more candidate in
  `reflectionAlongRow`, plus a marker in `rowShineLamp` that isn't a lamp's index. The user tried it in the design
  and set it aside for now (2026-10-31).
- **Light through portals.** The lighter doesn't follow D28's copies, so no light comes out of a doorway's
  destination (§3.3).
- Shadows cast by people or objects. Only walls block the light.
- Gestures with the lighter (sip, cheers), lighting it with a flick, fuel that runs out.

Anti-goals: anything that slows a crowded room down. Lighters held by many people must cost about what that many
avatar glows cost today, plus a shadow table each time a lighter moves (§3.2).

## 2. Approaches

1. **A held item whose light is a cone-shaped avatar glow, with a shadow table (chosen 2026-10-31).** It reuses the
   held-item protocol and storage and the glow's per-frame lighting. The shadow table is the one portal glows already
   use. The cost is the cells near each lighter, and a table rebuild when the holder moves.
2. The same without shadows. It is cheaper still, but a cone that shines through walls looks wrong at once.
3. A full dynamic lamp, with shadows, reflections and portal copies all redone every frame. That would mean moving
   the lamp lists out of the advance calculation, which is the expensive project the user wanted to avoid.

## 3. How it works

### 3.1 The item

- `HELD_ITEMS` gains `'lighter'`. `Digit9` and `Numpad9` pick it, and `0` or another drink key puts it away. The
  held-items rules (D15: one item in hand, remembered per browser) are unchanged.
- **Pressing `9` while holding the lighter does nothing:** no sip and no cheers *(our call: there is no gesture with
  it yet)*. The server relays no gesture for a lighter either.
- **Wire:** no protocol bump *(our call)*. Client and server ship together. An older tab's `isHeldItem` would read
  `'lighter'` as nothing in hand, which is harmless.
- Bots never hold it.
- **Look:**
  - On a disc: a 10×10 sprite in the same grip, a fist around a small silver case, with a two- or three-pixel
    flame above it. The flame pixels don't animate; only the light flickers *(our call: the cheapest)*.
  - In first person: the same sprite mirrored, in the left hand, peeking in from the bottom left like a drink
    (D15 §2.1).
  - The exact pixel map is left to the builder and tuned by eye.

### 3.2 The light

- **Where it comes from:**
  - Each person holding a lighter adds one `Glow` at their disc, at eye height, the way their face glow is placed.
  - The local player's own lighter adds one too, from their own position and facing.
  - The lighter's glow comes on top of the face glow and doesn't replace it.
- **What a `Glow` gains:**
  - `reach`: today every glow uses `GLOW_RADIUS` (2.5). Faces and portals keep 2.5, and the lighter uses
    `LIGHTER_REACH` = 4 tiles.
  - `cone: { dx, dy, cos } | null`. With a cone, `glowLight` scales the light by a smooth step from 0 at the cone's
    edge to 1 a little inside it. The cone's half-angle is 35°, with the last 10° fading out.
  - Everything that reads glows (`addGlow` and `findColumnGlows` in `walls.ts`) honours both, through `glowLight`
    and the reach.
- **Colour and flicker:**
  - The colour is warm, about linear (1.0, 0.55, 0.2) × `LIGHTER_STRENGTH` 1.5 (0.8 at first, whose pool on the floor hardly
    showed in an offline render; then 3, too bright in play, 2026-10-31). The reach of 4 tiles played right.
  - Its brightness flickers ±10% on a cheap noise of the time, a few times a second, with a different phase per
    holder (from their key).
  - All of these numbers are starting values, to be tuned by playing.
- **Facing:**
  - `Sprite` gains the person's `angle`, since every pose already carries it, interpolated like the position.
  - The cone points along that angle.
- **Shadows:**
  - Each lighter has a `GlowShadow`. It is built with `seenShare` from the flame's point (a `Light` at eye height),
    over every floor cell within `LIGHTER_REACH`, like `bakePortalGlowSeen`.
  - The table covers the whole disc around the flame, not just the cone, so turning never rebuilds it.
  - It is rebuilt only when the holder has moved to another floor cell (1/`FLOOR_SUB` of a tile). Until then the old
    table is reused.
  - Tables are pooled per holder key, so nothing is allocated per frame.
  - Starting cost estimate: about 64×64 cells, with several sight lines each in the penumbra. If one rebuild costs
    over about 1 ms in `pnpm bench:walls`, the builder may cut it to hard shadows (one sight line per cell), skip
    cells outside the widest the cone could reach, or spread a rebuild over two frames. That choice is the builder's
    and must be recorded with the measurement.

- **Objects.** The vacuum and the ball take each lighter's light per face direction, the way they take a lamp's
  (`directLight`): falloff, cone and the lighter's shadow table at the object's spot. Their images in the floor do too.
  Face and portal glows still don't light objects.

### 3.3 Portals

- The shadow table uses `seenShare` with the room's portals when portals are on. So the light stops at a doorway's
  front instead of spilling into the room physically behind it, which matches D28's "light follows sight".
- It doesn't carry on through the doorway: no copy of the lighter lights the destination side. That is the non-goal
  above, a follow-up.
- The light is drawn in window passes as it is in the main pass, the way glows are already handed to `drawWindow`.

### 3.4 Unchanged

- Unlit rooms (`?lights=off`) and the flat mode: the lighter is drawn in the hand and lights nothing, like face glow.
- Telemetry: none added.
- The ray-traced spike renderer is out of scope.

### 3.5 Sound (added 2026-10-31 at the owner's request)

- **Lit:** the lid clicks open (thin brass partials at 2.8, 4.1 and 6.3 kHz), then 0.12 s later the flint rasps (noise
  band-passed round 3.5 kHz) and the flame catches (a low rush of noise under 600 Hz).
- **Put away:** the lid snaps shut, a duller clack at 1.2 and 2.4 kHz.
- **Swapping:** changing one drink for another makes no sound.
- **Who hears it, and from where:**
  - Others hear a peer's lighter from where that peer stands, through the voice path, like the ball (`lighter:<id>`).
    It is detached when they leave.
  - The holder hears their own unplaced.
  - Only changes sound: a welcome or a join that lists a lighter already lit plays nothing.
- **Level:** `LIGHTER_GAIN` 0.15, like the ball's, keeps its loudest part 12 dB under a voice. It hasn't been tuned by
  ear.



- **First, failing tests** for:
  - the cone falloff in `glowLight` (inside, at the edge, behind, beyond `reach`);
  - the shadow table (a cell behind a wall sees 0; it rebuilds only when the holder changes cell);
  - `heldForKey('Digit9')`, and `heldKeyAction` never sipping a lighter;
  - `isHeldItem('lighter')` and the peer parse.
- **Benchmarks:**
  - `pnpm bench:walls` with no lighter must keep today's pixel hashes. Proof that `reach` and `cone: null` change
    nothing.
  - Add a lighter case for its frame cost and the rebuild cost.
- **By hand:** walk with a lighter in a local room, with a second tab watching, then tune the numbers in §3.2.
- **Docs:** record it as D31 in `docs/open-decisions.md`, and add a line to `AGENTS.md` gotchas: lighter glows are
  glows with a `cone` and a moving shadow table, and they make no reflections.
