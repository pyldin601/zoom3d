# Kick scooters

Date: 2026-11-07. Status: approved by the owner 2026-11-07; built (D36).

## 1. Intent

People should be able to cross the room faster than walking. Kick scooters stand in the room. Anyone can walk up to
one, step on, ride it at about twice walking speed, and step off wherever they like. The scooter stays where it was
left, so over a party the scooters scatter around the map, the way they would in a real office.

## 2. Goals, non-goals, anti-goals

**Goals**

- A rack of scooters near the spawn point in every room.
- Getting on and off one with a single key (and a touch button).
- Riding about 2× walking speed, which the server accepts.
- Everyone sees who is riding, and where every parked scooter is.
- Parked scooters survive a server restart.

**Non-goals (v1)**

- Scooters on the automap. The automap shows no objects today.
- Sounds: no wheel hum, no click on mount.
- A first-person view of the handlebar.
- Coasting or momentum. Speed changes at once, the same as walking.
- Bots riding.
- Scooters returning to the rack. The owner chose "stay where dropped" on 2026-11-07.
- Collisions. Nothing collides with a parked scooter: people, the ball and the vacuum all pass through it.

**Anti-goals** (it fails even if it technically works when):

- A rider visibly slides out of step with their scooter. This is why a ridden scooter is drawn from the rider's own
  pose (§4).
- Riding lets someone fling the ball harder than a fast walker can.
- Server corrections snap a rider back because the move check still expects walking speed.
- A scooter is lost: it vanishes on a disconnect, a reload or a restart.

## 3. Approaches

- **A: A scooter is always a world object, with a `rider` field.** The server moves it to the rider each tick. The
  rider and the scooter would arrive as two separately delayed streams (near and far peer delays, object delay), so
  the scooter would lag or slide under its rider without special-casing. Every pass that draws objects would also
  need to skip or pin a ridden one.
- **B: Parked scooters are world objects; a ridden scooter belongs to its rider.** The owner picked this, 2026-11-07.
  Stepping on removes the scooter from the room's objects and marks the rider as riding it. Stepping off puts it back
  at the rider's pose. The rider's sprite draws the scooter under them, so the two can't drift apart. This reuses how
  `held` items travel.
- **Rejected: client-only.** The server's move check would reject the speed, and nobody else would see the scooter
  or where it was parked.

## 4. Design

### 4.1 Shared (`packages/shared`)

**`objects/scooter/scooter.ts`**, pure, with tests:

- `RIDE_SPEED = 6` (tiles/s), which is 2 × `MOVE_SPEED`.
- `MOUNT_REACH = 1` (tiles, from the rider's centre to the scooter's).
- `SCOOTER_COUNT = 4`. *Amended 2026-11-07 (owner):* 6, side by side against the south wall of the hall just
  south of the spawn room (y 55.5, handlebars north). *Amended 2026-11-08 (owner):* one a cell, x 32.5 to 37.5 (they
  were two tiles apart, x 29.5 to 39.5).
- `rackSpots(map)` returns the scooters' starting poses. Start with a fixed list of floor tiles beside the level's
  spawn, all facing the same way. A test checks that every spot is floor and not the spawn tile itself.
- `canMount(rider, scooter)` checks distance only: within `MOUNT_REACH`.
- `parkedAt(rider)` gives the pose of a scooter dropped by a rider: the rider's x, y and angle.
- Save and restore follow the vacuum: a list of `{ id, x, y, angle }`, keyed by `mapFingerprint`. A save for another
  map, or with any spot inside a wall, is dropped and the room gets a fresh rack.

**Movement:**

- `stepPlayer` takes a `speed` (default `MOVE_SPEED`).
- While riding, **forward** uses `RIDE_SPEED`. Backward and strafe stay at `MOVE_SPEED`, since a scooter is ridden
  forward. Turning is unchanged.

**Move check:**

- `isPlausibleMove` takes the speed limit to check against (default `MOVE_SPEED`).
- The server passes `RIDE_SPEED` while the peer rides, and for 1 s after they step off, so poses already in flight
  aren't corrected.

**The ball:**

- `BODY_MAX_SPEED` stays `MOVE_SPEED * 1.5`. A rider pushes the ball no harder than a fast walker (anti-goal).
- The server's `peer.vx/vy` uses the ride limit for its "walked" test, so a rider's push isn't zeroed as a jump. The
  push is still capped by `BODY_MAX_SPEED`.

**Protocol (`PROTOCOL_VERSION` 5 → 6):**

- `ObjectKind` gains `'scooter'`. Parked scooters are `ObjectInfo` in `welcome.objects`, with no velocity and no mood.
- `PeerInfo` gains `riding: string | null`, the scooter's id. `parsePeerInfo` defaults a missing value to `null`.
- `welcome` gains the joiner's own `riding: string | null`, so a reloaded tab resumes on its scooter. After a restart
  it is always `null`. (Builder check; my call.)
- Client → server:
  - `{ type: 'ride'; id }` asks to mount scooter `id`.
  - `{ type: 'dismount' }` steps off.
- Server → room, including the sender:
  - `{ type: 'peer_ride'; id; scooter: string }` means peer `id` is now riding `scooter`. Receivers remove that
    object.
  - `{ type: 'peer_ride'; id; scooter: null; parked: ObjectInfo }` means peer `id` stepped off. Receivers add
    `parked`.
- Why the version bump: an older tab would see riders moving at twice the speed with no scooter, and scooters that
  vanish and reappear. The bump makes it reload.

### 4.2 Server (`apps/server/src/lobby.ts`)

**Per room:**

- `scooters: Map<id, ScooterPose>` holds the parked scooters.
- A ridden scooter's id lives only on its rider's `Peer.riding`.
- Behind a `scooters?: boolean` option, like `vacuum` and `ball`, so existing tests stay unchanged. On in `main.ts`.

**`ride(conn, {id})`** is accepted when all of these hold:

- the peer isn't already riding;
- `id` is parked in their room;
- `canMount` holds from where the server last saw them.

Through a portal, the test uses the scooter as seen from the rider (`seenFrom`, as with kicks). An accepted ride sets
`peer.riding`, deletes the parked entry and broadcasts `peer_ride` to everyone. A refused ride sends nothing back; the
client stays on foot.

**`dismount(conn)`:** if riding, the server parks the scooter at `parkedAt(peer)`, clears `riding`, records the time
(for the 1 s speed grace) and broadcasts `peer_ride` with `parked`.

**Leaving:**

- During the resume grace, the peer keeps riding, so a reload resumes on the scooter.
- When the peer is finally removed (expiry or explicit leave), the scooter is parked at their last pose and the
  dismount is broadcast to whoever remains.

**Snapshot:**

- Saves the parked scooters, plus each ridden scooter as parked at its rider's pose.
- Riders are restored on foot.
- `SnapshotPeer` (which extends `PeerInfo`) omits `riding` explicitly, so `LobbySnapshot` stays version 1.

**Bots** never ride. Their `riding` is always `null`.

### 4.3 Client (`apps/web`)

**Input:**

- `KeyE` toggles riding: `room-keys.ts`, next to B and Y.
- **Q/E turning is removed** (the owner, 2026-11-07): E was `turnRight` in `keyboard.ts` `BINDINGS`, and Q goes with
  it so turning stays symmetric. Turning is the mouse and the arrow keys. `keyboard.test.ts`'s Q/E case changes to
  match; no UI text mentions Q/E.
- On foot, E sends `ride` for the nearest parked scooter within `MOUNT_REACH`, measured in apparent positions through
  portals. With none in reach it does nothing.
- Riding, E sends `dismount`.
- The local player switches to ride speed only on its own `peer_ride`, never optimistically. A refused or raced
  mount just doesn't happen.
- **Touch:** a "Scooter" button in the touch UI, shown while a parked scooter is in reach or while riding. It does
  what E does.
- **Hint:** while a parked scooter is in reach and the player is on foot, a small on-screen hint "E: ride" (touch:
  the button itself).

**Drawing:**

- A voxel model, `renderer/models/scooter.ts`: deck, two wheels, stem and handlebar. Roughly 0.6 tiles long and
  0.55 tiles tall to the bar.
- Parked scooters are ordinary voxel objects, so they get lamp shadows, the floor mirror, lighter light and portal
  windows like the vacuum and ball.
- A ridden scooter is a pooled `VoxelInstance` set each frame from the rider's **drawn** (interpolated) pose. It is
  added to the same object list `renderSprites` and `renderWalls` take, so its shadow and mirror image come free.
  The face sprite is lifted by the deck height.
- A rider doesn't bob. The bob is distance-driven, so riding skips it.
- The local player's own scooter is drawn only in portal-window passes, like `RoomScene.self`.
- The rider's own eye stays at `EYE_HEIGHT`. Raising it would thread a per-view eye height through every pass, for
  0.1 tiles nobody would notice. (Builder check; my call.)

### 4.4 Docs

- **D36** in `docs/open-decisions.md`: the decision, approach B, the speeds and what's left out.
- **AGENTS.md** gotchas: a ridden scooter is drawn from its rider, never as an object; the move check's speed comes
  from `riding`; the ball's body cap stays at walking.

## 5. Tests

- **Shared:**
  - `canMount` reach;
  - `rackSpots` are floor;
  - `stepPlayer` speed per direction;
  - `isPlausibleMove` with ride speed;
  - save and restore, including another map and a scooter in a wall;
  - protocol parsing of `ride`, `dismount`, `peer_ride` and `riding`.
- **Server lobby:**
  - a mount is accepted within reach and refused beyond it;
  - two people race for one scooter and the first wins;
  - a rider's 6 tiles/s isn't corrected, while a walker's is;
  - poses in flight within 1 s of stepping off aren't corrected;
  - stepping off parks the scooter at the rider's pose;
  - expiry parks it; a resume keeps riding;
  - the snapshot round-trips, with a ridden scooter saved as parked;
  - bots never ride.
- **Renderer:**
  - with no scooters, `bench:walls` and `bench:sprites` hashes are unchanged;
  - a new hash covers parked and ridden scooters.
- **E2E** (one spec): two players; A walks to the rack, presses E and rides; B sees A riding; A steps off and B sees a
  parked scooter there.

## 6. Left to the builder

- The exact rack tiles and facing.
- The voxel model's look and colours.
- The hint's styling.
- Where the touch button sits in the tray.
