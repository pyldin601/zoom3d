# Ball (first interactive object): design spec

Status: approved design, implemented 2026-10-23. Decision record: [open-decisions.md](../../open-decisions.md) D26.

Calls marked **(my call)** were made by the designer, not by the product owner, and can be overridden.

## 1. Intent

Every room gets a ball. Anyone can dribble it by walking into it or kick it with a key, and it moves by plain
rolling-ball dynamics: it keeps its momentum, slows by friction, and bounces off walls, people and the robot vacuum.
It is the first thing in the room that people act on, and something to do with your feet while you talk.

### Goals

- One ball per room, spawned at a random floor spot when the room is created, like the vacuum.
- **Two ways to touch it** (product owner's choice, "do both"):
  - **Push:** walking into it shoves it along the way you walk, so you can dribble.
  - **Kick:** a key (Space; a button on phones) sends it hard the way you face, when you're close enough.
- Dynamics: momentum, rolling friction, elastic-ish bounces off walls, people and the vacuum.
- **Your own touches feel instant** (product owner picked approach B, §3). Dribbling must not feel like walking
  into a ball that hasn't noticed you yet.
- Everyone sees the same ball. Small, brief disagreements while two people touch it at once are acceptable.
- **The vacuum kicks it too** (product owner): when the robot drives into the ball, the ball is knocked away.
- It survives a server restart, like the vacuum.

### Non-goals

- **Height.** The ball stays on the floor; no lofted kicks, gravity or bouncing up (product owner: "stay on the floor
  for now").
- Spin, curve, or a charge-up kick **(my call)**: one fixed kick strength.
- Goals, scores, teams, a "who kicked it" label or any game rules. The vision's "no game rules" still holds.
- More than one ball, or picking it up/holding it.
- The ball on the automap.
- Bots touching it. Bots don't push or block it, for the same reason they don't bump the vacuum: a 100-bot stress room
  would pin it **(my call)**.
- The vacuum noticing the ball. It knocks the ball away (§2) but drives on as if nothing were there: no stop, turn
  or `bump` event, and its route is unchanged **(my call)**.
- People being blocked by the ball. People walk through it like they walk through the vacuum; only the ball reacts.

### Anti-goals (a failure even if it works)

- Dribbling feels laggy or rubbery: the ball visibly waits, or the local ball keeps snapping back after your own touch.
- Clients disagree for long: once nobody is touching it, every screen shows the ball at rest in the same spot.
- The ball costs frame rate (no per-frame allocations; `pnpm bench:sprites` holds).
- One client can teleport the ball or kick it from across the room.
- Its sounds compete with voices.

## 2. Physics (pure, shared)

A pure module `packages/shared/src/objects/ball/` (like `objects/vacuum/`), used unchanged by the server and the client:

```ts
interface Ball { id: string; x: number; y: number; vx: number; vy: number; seq: number }
stepBall(map, ball, dt, touchers, out) // → BallEvent | null, mutates ball
kickBall(ball, from, angle)            // → boolean (in reach)
```

Constants are starting points, tuned by playing **(my call)**:

| | Value | Why |
|---|---|---|
| Radius | **0.2** tiles | ~20 cm at this scale (1 tile ≈ 0.47 m); about knee-high to a face disc |
| Rolling friction | constant deceleration **2 tiles/s²** | a kick rolls ~16 tiles, about a long room |
| Kick speed | **8 tiles/s** along the kicker's facing | well above walking (3), so a pass beats a walk |
| Kick reach | centre distance ≤ `PLAYER_RADIUS + radius + 0.5` | close, not across the room |
| Wall restitution | **0.6** of the normal speed kept | |
| Person / vacuum restitution | **0.4** | soft bodies |
| Stop | speed < **0.05** tiles/s → set to 0 | it comes to rest exactly, so clients agree |

- **Integration:** sub-step so no step moves more than half the radius (no tunnelling at kick speed).
- **Walls:** circle against tile grid. Axis-separated like `moveWithCollision` is acceptable: a blocked axis reflects that
  velocity component times restitution. Corners may use the same rule **(my call)**.
- **Friction** reduces speed, never reverses direction.
- **Push (walking into it):** each touching body is a circle (`PLAYER_RADIUS`) with a velocity. On overlap the ball is
  moved out along the normal, and if the body is moving into it, the ball's normal velocity becomes at least the
  body's normal velocity times **1.2**, so the ball rolls a bit ahead of a dribbler and doesn't stick to their feet. A
  standing person is a wall with person restitution: a rolling ball bounces off them.
- **Vacuum:** a circle of radius 0.35 moving at the vacuum's velocity (the server derives it from its pose change
  over the tick; zero while it turns in place). A ball rolling into a still vacuum bounces with person restitution.
  When the vacuum drives into the ball, the ball is **kicked**: its normal velocity becomes at least **2.5** tiles/s
  away from the vacuum (the vacuum's 0.6 tiles/s alone would barely nudge it), with a `kick` event, so a collision
  reads as a kick, not a shove **(my call on the speed)**. That event carries no `by` (§4).
- **Events** for sound: `'kick'` and `'bounce'` (a wall, person or vacuum hit above **1** tile/s normal speed). One
  message carries one event, so when a tick has both, `kick` wins **(my call)**.
- **Rolling look:** the ball's visible spin isn't simulated or sent; the client derives it from distance travelled
  (§5).

## 3. Who runs it: server authoritative, client predicted (approach B)

### 3.1 Approaches considered

| | How | Trade-off |
|---|---|---|
| A | Server runs it like the vacuum; clients draw it ~150 ms in the past | Simplest; your own kick shows ~200 ms late and dribbling walks into a ball that hasn't moved yet |
| **B (picked)** | Server runs it; each client also runs the same sim, applies its own touches at once and eases onto the server's ball | Instant feel; more client code and small corrections when two people touch it at once |
| C | Whoever touched last runs it and tells the others | Responsive but breaks on simultaneous touches and disconnects, and lets one client steer the ball for all |

The product owner picked **B**.

### 3.2 Server

- `Lobby` holds one ball per room next to the vacuum (spawn in `spawnVacuum`'s place, `restore`, room close). Option
  `ball?: boolean`, off unless set, like `vacuum`, so tests counting broadcasts keep working.
- Stepped in `stepWorld` every fan-out tick (66 ms), only while the room has someone connected.
- Touchers: connected people (`isPerson`), each with a velocity the server derives from their last two accepted poses
  (position delta over time delta, zero if older than ~200 ms) **(my call)**. Plus the vacuum as a moving circle (§2).
- **`kick` message** (client → server): `{ type: 'kick', angle: number, k: number }`, `k` a per-client kick counter.
  The server kicks from the sender's last
  accepted pose with that angle, if the ball is in reach with **0.5 tile extra slack** for latency (the client may see
  itself further along than the server does) **(my call)**. At most one kick per 250 ms per person; others are dropped.
  A kick out of reach is dropped silently.
- **Broadcast:** `object_state` with velocity (§4) every tick **while the ball moves**, one more on the tick it stops,
  and none while it rests. A rested ball costs nothing.

### 3.3 Client prediction

The client keeps a local `Ball` and steps it every frame with the shared `stepBall`. Its touchers are **only the local
player** (at its current, unbuffered pose and velocity). Other people's and the vacuum's effects arrive from the server.
The ball is drawn at the **local** ball's position: in the present, not at the object delay.

- **Own push:** happens in the local step as the local player overlaps it. No message: the server sees the same push
  from the player's poses.
- **Own kick:** Space applies `kickBall` locally at once (if in local reach) and sends `kick`.
- **Reconciling with the server:**
  1. `object_state` has no `age` (only `peers` entries do), so the client treats each as the server ball one estimated
     one-way latency ago and advances a copy of it to now with `stepBall` (no touchers) **(builder picks the estimate; a
     fixed 60 ms is fine)**.
  2. **While the local player is touching the ball, and for 300 ms after the last local push or kick,** the local ball
     is left alone (the server hasn't seen the touch yet, and pulling toward it is the snap-back the anti-goals forbid).
     A server state that already includes the local kick is recognised by its `kick` echo (§4: `by` is the local
     player's id and `k` is at least the local kick's); then the hold ends early. Pushes have no echo and just use the
     timeout. Other people's touches never end the hold **(my call)**.
  3. Otherwise the local ball eases onto the advanced server ball: position error decays with a ~100 ms time constant,
     velocity is taken from the server. An error over **1.5 tiles** snaps.
  4. A ball at rest on the server with the local one at rest within 0.05 tiles: snap exactly, so all screens agree.
- On `welcome` the local ball is reset to the server's (seq resets after a restart, as for the vacuum).

## 4. Protocol

- `ObjectKind` gains `'ball'`; `ObjectEvent` gains `'kick' | 'bounce'`.
- `object_state` and `welcome.objects` entries gain optional `vx`, `vy` (tiles/s). Missing → 0. The vacuum leaves them
  out. Their required `angle` is the ball's direction of travel (kept when it stops); the client uses it as the roll
  axis.
- An `object_state` with `event: 'kick'` also carries `by` (the kicker's peer id) and `k` (the kicker's kick counter
  from the `kick` message), so the kicker recognises its own kick (§3.3, §6). A vacuum kick has neither.
- New client message `KickMessage = { type: 'kick'; angle: number; k: number }`, validated like `state` (finite angle,
  non-negative integer `k`).
- **No `PROTOCOL_VERSION` bump** **(my call)**: older clients drop the unknown `'ball'` kind from `welcome.objects` and
  ignore `object_state` for ids they don't have (checked: `parseObjectInfo` and `applyObjectState`). Server and web
  ship as one release, so no new client meets an old server for long; an old server ignores an unknown message type.
  The builder confirms that last point and bumps if it doesn't hold.
- The 6d fan-out batches peers only; the ball rides `object_state` like the vacuum.

## 5. Look

- A voxel ball built in code (`renderer/models/ball.ts`): a sphere of voxels **8 across** (0.05-tile voxels, radius
  0.2), white with black patches in a rough classic football pattern. Chunky is fine; it matches the vacuum.
- **Rolling, by recolouring** **(my call)**: the voxel pipeline can't rotate geometry off the vertical axis (it drops
  bottom faces and lights lit rooms by five fixed face directions). So the voxel sphere stays put and its **colours
  roll**: each frame, every exposed face's colour is looked up from the patch pattern at the face's position rotated
  back by the ball's accumulated roll (about the horizontal axis perpendicular to travel, angle = distance / radius).
  The ball keeps its own accumulated rotation (a small quaternion or matrix, client-only, not synced), writes into the
  model's existing `base`/`colors` arrays in place, and allocates nothing. The silhouette is a sphere anyway, so this
  reads as a real roll.
- Banded floor shadow like avatars and the vacuum (`shadowRadius` 0.2).
- Not on the landing page.

## 6. Sound

- `kick`: a short, soft leather thump. `bounce`: a lighter tap at one fixed level (the wire carries no impact
  speed) **(my call)**. Synthesised in Web Audio
  like the vacuum's beeps, spatial through `AudioEngine.attachNode` (distance, pan, reverb, line-of-sight muffle).
- No rolling sound **(my call)**.
- Level: like the vacuum, clearly below a voice at the same distance; tuned by ear.
- The local player's own kick sound plays at once from the local event; the server's echo of that same kick must not
  play it twice (skip a `kick` event whose `by` is the local player).

## 7. Input

- **Desktop:** `Space` in `room-keys.ts` → `{ kind: 'kick' }`, ignoring key repeat. Space is unused in the room today.
- **Touch:** a kick button in `touch-controls`, shown only while the local ball is within kick reach. No new layout
  modes; it sits with the existing room controls **(builder places it)**.
- No kick while the console is open or any form control (`input`, `select`, `button`, `textarea`) has focus: `roomKey`
  today only skips focused `<input>`s, so the kick needs its own check. `preventDefault` on the Space press so the
  page doesn't scroll.

## 8. Restart survival

The snapshot saves the ball per room as `{ x, y }` (at rest on restore), keyed by `mapFingerprint` like the vacuum.
Optional per room, so `LobbySnapshot` stays version 1; `parseSnapshot` parses it explicitly. A missing or mismatched
ball spawns a fresh one.

## 9. Testing

Failing test first for logic (AGENTS.md):

- **Physics (shared, pure):** a driving vacuum kicks it to at least 2.5 tiles/s with a `kick` event, a turning one
  only blocks it; friction stops a ball in the expected distance; a kick's speed and direction; reach
  rule; wall reflection with restitution on both axes; no tunnelling through a 1-tile wall at kick speed; a moving
  person pushes it ahead (ends faster than the person); a standing person makes it bounce; events fire above the
  threshold only; it comes to exact rest.
- **Server:** spawn on room create and restore; kick validation (reach with slack, rate limit, finite angle);
  broadcasts only while moving plus the stopping tick; bots never touch it; snapshot round trip and old snapshots
  without it.
- **Protocol:** parse `kick` (with `k`), `vx/vy` defaults, the kick echo (`by`, `k`), the new kind and events.
- **Client prediction (pure part):** the reconciliation function from §3.3: hold during and after own touch, release
  on the own kick echo but not on anyone else's, ease, snap above 1.5 tiles, exact snap at rest.
- **Renderer:** exposed-face count of the ball model; rolling recolour: zero roll gives the base pattern, a half turn moves a top patch to the bottom, and no allocation.
- **Audio:** ball gain below a voice at the same distance; no double kick sound.
- **Bench:** a rolling ball in view in `pnpm bench:sprites`.
- **E2E (builder's call):** walk into the ball and see `window.__game` report it moving; Space near it sends it off.

## 10. Code that assumes every object is the vacuum

These treat all objects alike today and need a ball branch:

- `game/remote-world.ts`: draws every object through `INTERP_DELAY_MS` and imports only the vacuum model. The ball
  is drawn from the local predicted sim instead.
- `audio/object-sounds.ts`: starts a hum for every object; the ball has no hum, only its events.
- `net/session.ts` `applyObjectState`: feeds the ball's states to the reconciler.

## 11. Docs to update in the same change

- `open-decisions.md`: add **D26 — The ball, the first interactive object**: server-authoritative with client
  prediction, push + kick, floor-only, bots don't touch it, the vacuum kicks it but otherwise ignores it.
- `vision.md`: Non-goals: interactive map elements are still out *except the ball*; game rules still out.
- `AGENTS.md` Gotchas: the ball is drawn from the client's predicted sim in the present, unlike every other object
  and peer; don't put it through the interpolation delay.
- `public/privacy.html`: no change.

## 12. Left to the builder

- Exact constants within §2, the latency estimate, ease time constant and hold time in §3.3, tuned by playing.
- Corner-collision detail; rolling-transform implementation; synth patches; kick button placement.
- File and function names.
