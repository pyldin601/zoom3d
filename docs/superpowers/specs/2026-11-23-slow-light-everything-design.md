# Slow light for everything — design

Date: 2026-11-23. Status: proposed. Decision: D41 in `docs/open-decisions.md` (once approved). Builds on D39 and D40
([slow light](2026-11-22-slow-light-design.md), [honest slow light](2026-11-22-slow-light-honest-design.md)).

## 1. Intent

The owner, playing with slow light: "make sure the speed of light applies to other players, all objects, all shadows,
all lights, everything, so everything is in sync"; "if I see another player passing by on a scooter, the speed of light
should apply to it too"; "scooter, ball, vacuum cleaner, everything should share the same speed of light logic".

D39 and D40 delay *where* remote things are drawn and bend the room by the local player's own motion. Everything else a
remote thing shows is still live, and a thing's own motion changes nothing about how it looks. This makes every remote
thing go through **one seen-thing rule**: what the eye sees of it (where it is, how it moves, what it holds and does, its
face) is what it was when the light now reaching the eye left it, and its own motion shifts its colour and brightness
and turns its model as the local player's motion does for the room. The room's lights-out sequence travels at c too.

Still a per-person look: only this screen changes, nothing goes on the wire, the server is untouched, gameplay reads
true state.

## 2. Today (audit, 2026-11-23)

Already at the light time, and in step with each other: every peer's, bot's and object's position (`seenAt` in
`RemoteWorld.sample`), the ball's hop, tremble and roll, and everything drawn from those positions: discs, riders'
scooters, held items' places, lamp shadows (`renderWalls` takes the delayed sprites and voxels), the floor mirror, face
glows, lighters' and headlights' light, labels, the automap, and where sounds come from.

Still live:

- **What people do:** the held item (a drink, the lighter and its light, the boombox), sips and cheers, the mic badge,
  stepping on or off a scooter (the parked scooter vanishes at once, and pops up under the late rider), picking up and
  letting go of the ball (the ball jumps to the late dribbler's hand), joining and leaving.
- **Faces:** video is live (D39 non-goal).
- **A thing's own motion:** a scooter passing at near c looks exactly like one at rest, only late.
- **The lights-out sequence and the portal switch:** the whole room goes dark, and the doorways open, at one instant.

## 3. Goals, non-goals, anti-goals

Goals:

1. **Seen state.** Each remote thing's state changes are seen at its light time: held item, boombox, sips and cheers,
   mic badge, riding (the parked scooter, the rider's scooter and headlight), who dribbles the ball, arrivals and
   departures.
2. **Seen faces.** Face video at the peer's light time (owner, 2026-11-23: faces only, voices stay live, so lips lag the
   voice by the light time).
3. **Moving things look moving.** A thing's own velocity Doppler-shifts its colour and brightness (combined with the
   local player's own shift, so both moving works), and turns its voxel model by the Terrell rotation.
4. **The lights-out wave** (owner, 2026-11-23): lamps go out and come back for each floor cell and wall face when its
   light reaches the eye, so the dark spreads out from the eye at c; each doorway opens or closes when its light does.
5. **One rule for everything** (owner): peers, bots, the ball, the vacuum, parked and ridden scooters all take it from
   the same code.

Non-goals:

- **Sound stays live** (owner): voices, the boombox, the hum, motor whine, ball sounds and cries, portal hums, the
  sequence's switch sounds and the countdown. Sounds keep coming from where things are seen, as today.
- **Lit surfaces are not timed one by one.** A remote light (face glow, lighter, headlight) lights the room from its one
  seen pose; the local player's own glow, lighter and headlight light it from the present. Exact would need a light
  time per lit pixel (the source's pose at `now − (|P−eye| + |P−source|)/c`).
- **Discs keep their shape and face the eye.** By Penrose–Terrell a sphere's outline stays a circle at any speed; a
  billboard face can't show the turn, so discs only shift colour.
- **No Lorentz contraction of models:** for an object this small, the Terrell turn is the visible part.
- **Moving glows are not shifted:** the light a moving lighter or headlight throws on the room keeps its colour.
- **The floor mirror's images of moving things are not colour-shifted** (they are turned, §5.4).
- **The wave through windows is approximate:** a cell seen through a portal window goes dark and lights up by its own
  distance from the eye, not by the path through the window.
- Touch-only controls, settings beyond the existing Light row and slider.

Anti-goals: with light *Instant* the frame stays today's pixel for pixel (`pnpm bench:walls` and `bench:sprites`
hashes unchanged) and the game behaves exactly as today; no allocations per frame or per column (rings and tables are
allocated once, when the look first needs them); no change to what others see or to the server.

## 4. Approaches

- **Seen state.** A. *RemoteWorld records it (chosen):* each sample it compares each peer's live state with the last it
  recorded and pushes a change into that peer's small state ring, stamped `now`; it reads the ring at the light time.
  Frame-granular stamps (≤ 17 ms late) are invisible at these delays, and the net layer stays free of look concerns. B.
  The session stamps every change on arrival: exact, but every handler grows look code. Rejected.
- **A thing's Doppler shift.** A. *A shift plane (chosen):* the source frame carries one byte per pixel, the Doppler index
  offset of the moving thing drawn there; the bend adds it to its own per-pixel D. Colour and brightness then come out
  of the same matrix and tone curve as everything else. B. Tint the sprite's pixels as they are drawn: bytes can't hold
  light brighter than white before the tone curve, and the shift would be applied in the wrong order. Rejected.
- **The wave.** A. *A wave lighting table (chosen):* one `Lighting` with the room tables' layout, each cell and face
  copied from the table its seen time falls in, refilled only where that changes. One render, exact per cell. B. Render
  the source frame once per lighting state and pick per pixel by depth: there is no per-pixel depth (floors, sprites),
  it doubles or triples the bent frame's cost. Rejected.

## 5. Design

### 5.1 The seen thing

Per frame, for each peer and object, with slow light on (`light !== null`):

- `lightLeftAt` from `seenAt`, as today; `lateMs = drawnAt − lightLeftAt` (≥ 0): how late its light is, without the
  interpolation tier delay.
- `seenNow = now − lateMs`: the moment of its state the eye sees. State, gestures and faces are judged by this, so at
  zero distance they show exactly as today (the tier delay stays a pose-only matter).
- **Pose:** as today. **Velocity:** `(pose(lightLeftAt) − pose(lightLeftAt − VELOCITY_WINDOW_MS)) / window`, window
  about 150 ms (builder tunes: long enough to smooth 66 ms ticks); zero across a jump (portal) or without that history.
- **State, face:** the latest record at or before `seenNow` (§5.2, §5.3).

With the look off nothing here runs: live state, no velocity, today's code path.

One function per kind of source computes this, and peers, bots, the vacuum, scooters and the ball all use it; the ball's
trail and the local player's own trail are its pose source as today.

### 5.2 Seen state

- **Peer state ring** (`game/seen-state.ts`): about 32 snapshots `{ t, held, boombox, riding, mic, gesture }`,
  preallocated per peer when slow light is first on; a snapshot is pushed only when one of them differs from the newest.
  Read at `seenNow`; past the oldest, the oldest. Drives `fillSprite`/`fillLabel` (held, boombox, mic), the
  lighters and headlights, `handsFull`, the ridden scooter model.
- **Gestures:** `gesture` is the session's object (`{ kind, at }`); the seen one plays `gesturePose(kind, seenNow −
  at)`, and is null before `at`.
- **Arrivals:** `RemotePeer` and `RemoteObject` gain `since` (ms): `now()` for `peer_joined` and for a scooter parked by
  `peer_ride`, `−Infinity` for everything in a welcome (they were there all along). Unseen while `seenNow < since`.
- **Departures:** when the session drops a peer or object, RemoteWorld keeps a reference to it (its buffer, info and
  state ring) with `goneAt = now`, and keeps drawing it until `seenNow ≥ goneAt`, then forgets it. A departed peer's
  media is gone, so it shows its flat disc. Stepping on a scooter is the scooter's departure; stepping off, the parked
  one's arrival: both meet the rider's seen `riding` at the same light time, as rider and scooter stand together.
- **The ball:** its trail is pushed every frame, held or not, so it has no gap; a ball state ring holds `heldBy`. While
  the seen `heldBy` is someone else, the ball is at that dribbler's seen hand (`holdAt` from their seen pose, as
  today), else at its trail's seen pose. Held by the local player it stays in the present (D39 §4.3). Mood and lift
  keep their D39 trail.
- **Sounds and gameplay** keep reading live state.

### 5.3 Seen faces

- `FaceSource` (`media/faces.ts`) gains a history, started by the call when slow light turns on and dropped when it
  turns off: each copied video frame is also box-downscaled into two rings, 128² for the last ~1 s and 64² (every
  other frame) for up to ~8 s, each slot with its time; camera on/off and stalls are marked so a seen time where the
  camera was off shows the avatar or initials. About 4 MB per camera peer, allocated on first need.
- `faceAt(lateMs)`: the live 256² texels when `lateMs` is under one frame, else the newest stored frame at or before
  `now − lateMs`, from the 128² ring while it reaches, else the 64² one. Before the oldest stored frame, the oldest
  (my call): a peer whose video was paused out of sight (6c), or who just came into view, shows a held frame as today's
  resume does. The interest rule is unchanged.
- The rings are one `FaceHistory` (`media/face-history.ts`) fed texels and a time, so the local camera can feed one too
  (§5.6).
- `PeerMedia.faceOf(id, lateMs)`; `Sprite` gains `faceSize` (FACE_SIZE for live texels); the disc and its glow's average
  colour read it. With the look off `faceSize` is always FACE_SIZE: today's pixels.

### 5.4 Moving things

- From the seen velocity: turn it by the image's turn (`Apparent.cos/sin`) when seen through a portal; `n̂` = unit from
  the seen image toward the eye; `β = min(|v| / c, MAX_BETA)` (0.5, as for the eye); `D = 1 / (γ (1 − β v̂·n̂))`.
  Approaching it is bluer and brighter, receding redder and dimmer.
- `Sprite` and `VoxelInstance` gain `shift`: `D` as a whole number of Doppler-table steps (0 at rest). The source
  framebuffer gains a shift plane (`Int8Array`, one per pixel, zeroed each bent frame; null on every other
  framebuffer). `sprites.ts` and `voxels.ts` write the thing's shift wherever they write its pixel, when the plane
  exists; window framebuffers carry a plane too and their rows are copied with it. The bend adds the plane's value to
  each pixel's grid D index before the matrix. The table widens to ln D ∈ [ln ¼, ln 4] at the same step, D = 1 still an
  exact entry, so the eye's ×½..2 and a thing's ×½..2 combine without clamping.
- **Terrell turn** (voxel models only): with ψ the signed angle from `v̂` to `n̂`, and ψ′ its aberrated angle in the
  thing's own frame (cos ψ′ = (cos ψ − β) / (1 − β cos ψ), same side), the model is drawn turned by ψ − ψ′: crossing
  the view at β it shows its back, turned by arcsin β; head-on, not at all. `VoxelInstance` gains `turn` (0 by
  default), added to `angle` where the model and its floor-mirror image are drawn; its lamp shadow keeps the true angle.
  The ball's base angle stays 0 (its pattern rolls by recolouring); only `turn` turns it. A ridden scooter takes its
  rider's velocity.

### 5.5 The lights-out wave

- **The room's light timeline** (my call, after the builder check): the instant-light frame already picks, each frame,
  one lighting table and one sight set (`room.lighting(room.sequence.dark)`, `room.sightPortals()`), and today's
  timing rules stay theirs (the lamps wait for the server's bend, D30). With slow light on, the room loop records each
  change of that pair with its time in a short ring (about 16 entries; it must reach back `farthest/c`, farthest the
  map's diagonal). The wave replays that timeline: a place at distance `d` from the eye shows the pair the instant frame
  showed at `now − d/c`. So any sequence (`first_on`, `on`, `off`), two sequences close together, and a sequence still
  spreading when the next starts all come out right without special cases. A change of the portal look (classic or
  realistic) or turning slow light on restarts the timeline: those are this person's settings, not light.
- **When:** while the timeline holds a change newer than `now − farthest/c`. Otherwise the frame takes the room's table
  as today.
- **The wave table** (`renderer/light-wave.ts`): a `Lighting` with the room tables' layout, allocated once per room.
  Each frame of the wave, every floor and ceiling cell, bounce cell and wall face whose seen table changed is copied
  from it (`wall`, `wallLamp(Seen)` per face, `floor`, `ceiling`, `floorLamp(Seen)`, `bounce` per cell). `lights` is the
  lamps of each distinct table in the timeline, one after the other, and each cell's lamp indices are offset by its
  table's start. `ambient` is folded into `bounce` per cell (the dark table has neither). Things lit at a point (voxels'
  ambient, the lamps their shadows and light come from) take the table seen at that point.
- **Doorways:** a doorway is open when the sight set seen at its distance has it. While the wave runs, the sight
  portals are a pooled copy of the room's set with a per-portal open mask: `byTile` is −1 on closed doorways' tiles,
  `list` keeps every portal so the lighting's portal indices hold, and everything that walks `list` for sight
  (windows, portal glows, `apparentPosition`) skips closed ones. Rebuilt only when a doorway changes. `room.portals()`
  (gameplay) is untouched; the portal hums follow the live set, as sounds stay live.
- The bend and the light delay read the wave's sight portals while it runs.

### 5.6 The local player’s own image

Seen through a portal window (D39 §4.3), the own disc and scooter take the same rule (my call, "one rule for
everything"): `delayOwnImage` gives its light time; the own trail gives its pose and velocity (shift and, for the
scooter, the Terrell turn); an own state ring gives the held item, boombox and gesture it shows; a `FaceHistory` fed by
the local camera's texels gives its face.

### 5.7 Off is today

Light *Instant* runs none of §5: no rings, no faces history, no shift plane, no wave. `shift`, `turn` are 0 and
`faceSize` is FACE_SIZE. The `bench:walls` and `bench:sprites` hashes must equal `main`'s.

## 6. Tests (written first)

- Seen state: a held item, boombox, mic, riding and a gesture changed now show only once `seenNow` passes it; a peer
  joined now is unseen until its light arrives, one from the welcome at once; a departed peer and object keep being
  drawn until their light passes; stepping on a scooter swaps the parked one for the ridden one at one light time; the
  ball's `heldBy` is seen late, and its trail has no gap over a hold.
- Faces: `faceAt` by time across both rings, live under one frame, the fallback where the camera was off; the disc
  draws a 64² face.
- Moving things: D = 1 at rest, > 1 approaching, < 1 receding, combined index = eye + thing; Terrell turn arcsin β
  crossing, 0 head-on, showing the back; the shift plane gets the thing's shift where it is drawn and the bend applies
  it; the widened table is the identity at D = 1.
- Wave: bands by distance; the table equals before's before the dark reaches a cell, the dark table during, after's
  after; lamp indices offset; doorways open by distance; with no sequence the table is the room's own.
- Off: bench hashes unchanged; the existing suite passes.

## 7. Left to the builder

The velocity window, ring sizes and the faces' ring lengths; how bands are refreshed incrementally; where the shift
plane is written in each draw loop; how the wave table's farthest distance is bounded (the map's diagonal is enough).
