# Robot vacuum (first voxel object): design spec

Status: approved design, implemented 2026-10-11. Decision record: [open-decisions.md](../../open-decisions.md) D22.

Calls marked **(my call)** were made by the designer, not by the product owner, and can be overridden.

## 1. Intent

zoom3d gets its first **voxel object**, a small 3D model made of cubes and drawn inside the ray-cast view. Unlike face
discs, it can be seen from every side. The first object is a robot vacuum. It cleans the whole floor, slowly and
methodically, over the course of a long party. When it's done it goes looking for its dock and never finds one. The
joke is the ending; the charm is having a little machine pottering about while people talk.

The robot is ambient. You can hear where it is with your eyes closed, the way you hear voices, but it never gets in
the way of a conversation.

### Goals

- Voxel objects become a reusable thing: a model described in code, drawn depth-correct among walls and face discs.
  The robot is the first. More objects will follow, also described in code rather than drawn in an editor.
- Every room gets one robot vacuum, spawned at a random floor spot when the room is created.
- It cleans the map patch by patch, at a real robot vacuum's pace. A full clean takes **about an hour, or more**.
- When the floor is clean it searches for its dock forever, without success.
- It bumps into people, turns and drives around them.
- Its hum is spatial (distance, pan, reverb, muffled behind walls) and **quieter than voices**. You can hold a
  conversation standing right next to it.
- Everyone in the room sees and hears the same robot doing the same thing at the same moment.

### Non-goals

- Interacting with the robot: kicking, picking up, steering, docking it. The vision's "no interactive map elements"
  still holds.
- A visible dirty/clean floor. The cleaning shows in how it moves, not in the floor's colour.
- The robot on the automap, a name label, or a speaking ring.
- A voxel file format or editor import (`.vox`). Models are code.
- Players colliding with the robot. People walk through it; only the robot reacts to people **(my call)**.
- A setting to mute the robot.

### Anti-goals (a failure even if it works)

- The hum masks or competes with voices.
- The robot costs frame rate. The renderer budget (60 fps, 8+ people, `pnpm bench`) must hold, with no per-frame
  allocations.
- Each client shows a different robot (in a different place, or in a different phase).
- A deploy or server restart sends the robot back to an all-dirty floor.

## 2. Look

The agreed look is variant **C, "chunky retro toy"**, from the 2026-10-11 brainstorm mockup.

- **Shape:** D-shaped from above. The back is a half-disc and the front is flat. Seen from above it is
  **14 × 14 voxels**, with each voxel **0.05 tiles**. The flat front is cut at about 5.5 voxels from the centre.
- **Height:** **4 voxels** (0.2 tiles). The whole robot is 0.7 × 0.7 × 0.2 tiles, about a face disc wide and
  knee-high.
- **Colours:**

  | Part | Colour |
  |---|---|
  | Bottom layer (skirt) | dark brown-grey `#3c322d` |
  | Body | orange `#e87828` |
  | Top layer | lighter orange `#f58c37` |
  | Round top centre, radius ≈ 3.2 voxels | warm yellow `#fad250` |
  | Front bumper (voxels within one of the flat face, layers 1–2) | dark grey `#46464b` |
  | Two "eyes" on the bumper (layer 2, about ±2.5 voxels off centre, each about 2 voxels wide) | bright cream `#ffffd2` |

  The eyes show which way it's heading.
- **Shading:** flat per face. The top is brightest and the sides are darker, with the side shade depending on
  which way the face points. The builder picks the exact model: light fixed to the world or to the object.
- **Shadow:** it casts the same banded, low-res floor shadow as avatars, sized to its footprint.
- **On screen:** it sits on the floor and is never lifted or bobbed.

The mockup's model builder, which approximates the above, is kept with the brainstorm files
(`.superpowers/brainstorm/*/content/robot-look-v2.html`, function `build('toy')`). It's a starting point, not a spec.

## 3. Behaviour (server-authoritative)

The server owns the robot, as it owns the `?bots` wanderers. It simulates the robot and broadcasts its pose, and
clients only interpolate and draw.

### 3.1 Spawn and lifetime

- It's created when a room is created: in `Lobby.join` when the room is new, and in `restore()` for a restored room
  whose snapshot has no robot (§3.6).
- It starts at the centre of a random floor tile (`floorTiles`), facing a random direction.
- It steps only while the room has someone connected, like bots. During resume grace with nobody connected it's
  frozen.
- It goes away with the room. It never keeps a room open and never counts toward `MAX_PEERS` or the "people" counts.
- It is **not a `Peer`**. It isn't in `room` peers, `welcome.peers`, labels or the automap. It's a separate per-room
  world object (§4).

### 3.2 Speeds and body

- **Driving speed:** a true **0.6 tiles/s**, a real robot vacuum's 0.3 m/s at this game's scale (walking 3 tiles/s
  ≈ 1.4 m/s).
- **Don't copy the bots' speed handling.** Bots pass `dt * BOT_SPEED` to `stepPlayer`, which then multiplies by
  `MOVE_SPEED`, so they really move at 1.8 tiles/s. The robot moves with `moveWithCollision` directly instead
  **(my call)**.
- **Turns in place** at about **90°/s**. It doesn't curve; it stops, rotates, then drives.
- **Collision:** walls only, with radius **0.35** (`moveWithCollision` takes a radius). That fits 1-tile corridors.

### 3.3 Cleaning: patches

- The map is cut into a fixed grid of **3 × 3-tile patches**, aligned to tile (0, 0). A patch with at least one floor
  tile is *dirty* at spawn.
- **Next patch:** the robot picks the dirty patch nearest by walking distance (BFS over floor tiles) and drives there
  along a path. Tile-centre waypoints from BFS are fine; a straight line works where there's line of sight.
- **Inside a patch,** it follows a coverage route over the patch's floor with points **0.6 tiles** apart, a little under
  its width, so the lanes overlap:
  1. **Edge first:** it goes round the patch's outer ring.
  2. **Then fill:** it covers the inside in back-and-forth lanes.

  Points inside wall tiles are skipped. Points are pulled in so they stay at least the robot's radius from walls. The
  route is a sequence of waypoints. Between them it turns in place, then drives straight. When a straight line between
  two waypoints crosses a wall (patches can be L-shaped), it paths round on the tile grid.
- **Done:** when the route is finished, the patch is clean.
- **Waypoint give-up:** a waypoint is skipped when it can't be reached. That covers being blocked for **> 10 s**
  (someone standing on it) and making no progress (wedged on a corner).
- **Pace:** LEVEL1 has 164 patches with floor in them, 54 of them full. A unit test fast-forwards a full clean and
  holds it inside **50 min – 2 h**. It came to about 109 simulated minutes, with no point given up.
  - At half-tile spacing it took 138 minutes, 46 of them turning in place, so the spacing went up to 0.6 tiles.
  - Reaching a waypoint costs no time of its own.

### 3.4 Bumping into people

- **People only:** it reacts to people, **not bots** **(my call)**. A 100-bot stress room would otherwise jam it, and
  bots are test traffic.
- **Bump:** a bump happens when a connected person's position is within `0.35 + PLAYER_RADIUS` of the robot's centre,
  within about 78° of its heading, while it's driving. A person exactly beside it is not in its way.
- **Reaction:**
  1. It stops and the bump event fires (§4.2).
  2. It pauses about 0.3 s.
  3. It turns 90° away from the person and drives 0.7 tiles aside. If a wall is on that side, it goes the other way.
  4. It drives 1.2 tiles on, past the person.
  5. It turns back toward its current waypoint and carries on.
- **Repeat bumps** follow the same rule.
- **Give-up through detours:** a detour keeps the give-up deadline of the waypoint it leads to. Someone standing on a
  waypoint therefore costs the robot that waypoint after about 10 s, not forever.
- **When people move into it:** people walking through it don't count. Only its own driving into someone is a bump.

### 3.5 Searching for the dock (after the floor is clean)

When the floor is clean, it switches to `searching`, which lasts until the room closes:

1. It drives to a random floor tile far away, more than 10 tiles by path ("I think it's over there").
2. It stops and turns a slow full circle, scanning.
3. It plays the "lost" event: two sad descending beeps (§5).
4. It waits about 2 s, then picks another destination.

There is no dock anywhere. While searching it bumps into people exactly as in §3.4.

### 3.6 Restart survival

The robot is saved in the lobby snapshot with its room:
- position and heading
- phase (`cleaning` | `searching`)
- the set of clean patches, for example as patch indices

The patch in progress is restarted from scratch on restore. The field is optional per room, so `LobbySnapshot`
stays at `version: 1`. A snapshot without it gives the room a fresh robot.

Two more things about the snapshot:
- **Parsing:** `parseSnapshot` rebuilds each room as `{id, peers}`, so the new field must be parsed there explicitly,
  or it is silently dropped.
- **Map changes:** the saved robot carries a fingerprint of the map, for example a hash of its tiles. On a mismatch,
  such as LEVEL1 being edited between deploys, it's discarded for a fresh robot. Patch indices from another map would
  be meaningless **(my call)**.

## 4. Protocol

Generic **world objects**, so later voxel objects fit without new message types.

### 4.1 Shapes

```ts
type ObjectKind = 'vacuum';
interface ObjectInfo { id: string; kind: ObjectKind; x: number; y: number; angle: number }
```

- **`welcome`** gets `objects: ObjectInfo[]`, the room's objects at join. `parseServerMessage` defaults a missing field
  to `[]`.
- **`object_state {id, x, y, angle, seq, event?}`** is broadcast every server step (10 Hz) while the robot steps.
  - `seq` is monotonic per object. Clients drop stale ones, like `peer_state`.
  - `seq` restarts after a server restart, so the client resets its per-object `seq` and interpolation state on every
    `welcome`. Otherwise a resumed client would think every new pose is stale and the robot would freeze.
  - `event` is optional and only set on the step where it happens: `'bump' | 'lost'`.
  - Turning in place and stopping don't need an event. The client infers motion from the pose deltas it already
    interpolates (§5).
- **No join/leave messages:** objects are fixed for the room's life, so there is no `object_added`/`object_removed`
  yet (YAGNI).
- **Mixed versions:** older clients drop `object_state` (unknown type) and ignore `welcome.objects`. They simply don't
  see the robot.

### 4.2 Server tick

The 100 ms `BOT_TICK_MS` interval also steps objects. Rename it to something like `stepWorld`.

The paused 6d fan-out work (branch `feat/6d-server-fan-out`, batched per-client updates) will later fold
`object_state` into its batches. Build this on `main` as described here; 6d adapts when it resumes.

The vacuum's logic lives in its **own pure module**, for example `apps/server/src/vacuum.ts`:

```ts
createVacuum(map, rng)
stepVacuum(v, dt, people, map)  // → event | null
```

It's like `Lobby` with injected `rng` and no timers, so it's unit-testable with fixed seeds and a fast-forwarded
clock. The patch plan and route can be precomputed per map once (`floorTiles` is already cached that way).

## 5. Sound

The hum is synthesised in Web Audio, with no audio file.

### 5.1 The layers

| Layer | How it's made |
|---|---|
| **Airflow** | Looping noise through a soft band-pass around 900 Hz |
| **Motor** | A low triangle-wave purr around 110 Hz with a slow, slight wobble |
| **Brush** | Low-passed noise, amplitude-modulated at about 8 Hz |

The agreed character is variant **B, "soft purr"**, picked by ear from four candidates in the 2026-10-11 brainstorm
(`.superpowers/brainstorm/*/content/hum.html`). It's darker and lower than a real vacuum, so it's easy to talk over.
The exact values are in the plan's Task 8.

### 5.2 How it reacts

The robot's motion comes from its interpolated pose.

| When | What changes |
|---|---|
| Turning in place | The whine drops a little, about −10% pitch and slightly quieter |
| Standing still | It drops more |
| `bump` | A soft low thud plus a short pitch dip |
| `lost` | Two short descending beeps, sad and robotic, also spatial |

The builder tunes the exact patches by ear.

### 5.3 Spatial and level

It goes through the **same spatial path as voices** in `AudioEngine`: the same `voiceGains` distance curve,
`PannerNode`, reverb send and line-of-sight muffle.

The engine today only accepts `MediaStream`s. Extend it with an AudioNode source, for example
`attachNode(key, node, owner)`, keyed `object:<id>`. The node has no analyser or speaking detection. Routing it through
a `MediaStreamAudioDestinationNode` to fake a stream is not the way.

The robot's position must be in the `sources` map that `update()` reads.

**Level:** a fixed source gain, so that at any distance the hum sits clearly **below a normal voice at the same
distance**. As a starting point, aim for about 12–15 dB under typical speech peaks, then tune by ear. Standing right
next to it and talking to someone 2 tiles away must stay comfortable.

### 5.4 Lifecycle

- It starts when the room is joined. The `AudioContext` is already running by then.
- It stops on leave.
- It keeps sounding in a hidden tab, through the existing hidden-tab audio timer.

## 6. Rendering

### 6.1 Models

A voxel model is described in code (`apps/web/src/renderer/voxels/` or similar). It's a small builder that fills a
dense grid with palette colours, plus a voxel size in tiles.

At load, the model is preprocessed once into its **exposed faces**: faces whose neighbour cell is empty, each with its
corners in model space, its normal and its colour.

### 6.2 Drawing

The voxel object joins the sprite pass's **far-to-near order** as a single entry at its centre depth. A face disc
behind the robot is drawn before it, and one in front after it. The robot is small, so it isn't split.

For each object in each frame:
1. Rotate by the object's angle and translate.
2. Back-face cull against the camera.
3. Project with the same camera as walls and discs: `fb.fov`, eye at height 0.5, floor at 0.
4. Sort the faces far to near and fill the quads.

Every pixel is **depth-tested against `fb.zbuffer`**, so walls hide the robot correctly, including partly round a
corner.

This is what the mockup did. The builder may choose a different rasterisation, such as per-column or splatting, if it
fits the budget better.

### 6.3 Budget

- No allocations per frame: preallocate the transformed-face and sort buffers.
- Extend `pnpm bench` with a robot in view and keep the frame-time budget.

### 6.4 Placement and shadow

- **Position:** comes from the same interpolation as peers (`SnapshotBuffer`, `INTERP_DELAY_MS`).
- **Shadow:** `renderShadow` is module-private in `sprites.ts`. Export or generalise it.
- **Landing page:** the landing scene doesn't show the robot.

## 7. Testing

Write the failing test first for logic, per AGENTS.md:

- **Vacuum sim (server, pure):**
  - patch grid and dirty set
  - nearest-patch choice by path distance
  - route order: edge ring before fill
  - waypoints clear of walls
  - the bump reaction and the waypoint give-up
  - the switch to `searching` when the last patch is cleaned, never with dirty patches left
  - `searching` never ends
  - snapshot round trip, including old snapshots without the field
  - **a full-map fast-forward that lands in the 50 min – 2 h window (§3.3)**
- **Protocol:**
  - parse and validate `object_state` and `welcome.objects`
  - stale `seq` dropped
  - a missing `objects` field defaults to `[]`
- **Renderer math:**
  - exposed-face extraction (count for a known model)
  - projection and depth-test of a voxel face vs a wall column
  - far-to-near interleaving with a disc
- **Audio:**
  - the robot's gain is below a voice's at the same distance across the range, with fake audio context as in
    `engine.test.ts`
  - occlusion applies
  - `attachNode` lifecycle
- **Test hooks (my call):**
  - Lobby/server options can turn the robot off, so existing tests that count broadcasts keep working.
  - A **dev-only** setting (env var, ignored when `NODE_ENV=production`) starts the robot with every patch but one
    clean, so the dock-search ending can be seen by hand in a minute instead of an hour.
- **E2E (optional, builder's call):** after joining, `window.__game` exposes one `vacuum` object whose position changes
  over a few seconds.

## 8. Docs to update in the same change

- `open-decisions.md`: add **D22 — Voxel objects / robot vacuum** as resolved. Cover world objects as a server-driven
  per-room concept separate from peers, models described in code, the robot reacting to people but not bots, people
  walking through it, and the sound level rule.
- `vision.md`: under Non-goals, note that ambient world objects like the robot are in, while interactive elements are
  still out.
- `AGENTS.md`: under Gotchas, say that world objects are not peers (no labels, automap, `MAX_PEERS` or media), the
  robot's state is in the snapshot, and its sound goes through `attachNode`, not a `MediaStream`.
- `public/privacy.html`: no change; nothing new is collected.

## 9. Left to the builder

- Exact synth patches, gain constants and turn timings, within §3 and §5.
- The exact shading model, and the rasteriser if the mockup's quad-fill doesn't fit the budget.
- File and function names, and whether `Lobby` holds the robot or a sibling `World` per room does.
- The coverage route's exact waypoint generation, as long as it's edge-first, then lanes, and wall-safe.
