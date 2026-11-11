# Basketball Dribble Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** E near the ball picks it up into a basketball dribble that follows the player's walking and turning on every
screen; E lets go, Space throws, another person's kick or moving body steals it.

**Architecture:** The server marks the room's ball `heldBy` a peer, pauses its physics and mind, and places it at a
shared pure `holdSpot` from the dribbler's pose each tick. The dribbler's screen places it from the local player in the
present; other screens place it from the dribbler's drawn pose. The bounce is a drawn lift, like D34 hops.

**Tech Stack:** TypeScript, pnpm workspace, vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-10-ball-dribble-design.md` (decision D37). Read it before any task.

## Global Constraints

- Code style: `pnpm exec biome check --write .`; every `if`/`else`/`for`/`while` body braced; comments only say why
  (docs/code-style.md); names with units; `.at()` over `arr[i] as T`; no "you/your" in identifiers or test titles.
- No allocations per frame or per server tick in hot paths (`holdSpot` writes into an `out`).
- `PROTOCOL_VERSION` 6 → 7.
- Hold spot: `HOLD_FORWARD_TILES = 0.5` along the eye angle, `HOLD_SIDE_TILES = 0.2` to its right.
- Bounce: `DRIBBLE_PERIOD_S = 0.5`, `DRIBBLE_HAND_TILES = 0.45`, fastest at the floor.
- Riding: E only dismounts; dribbling: E only lets go; the server refuses `ride` from a dribbler.
- Mind while held: set to a fresh `createBallMind()` on pickup, not stepped while held, mood `asleep` on the wire;
  pickup is no kick (no `kickBallMind`); a throw goes through `kickBallMind`.
- Body steal needs the other person moving (`now - poseAt <= MOVING_POSE_MS` and non-zero velocity).
- Bots never dribble or steal; a held ball is saved in the state file as not held.
- Failing test first for every logic task; run `pnpm test`, `pnpm typecheck`, `pnpm lint` before each commit.

## Review Focus

- A dribbler walking along a wall or into a corner: the ball must never sit inside a wall (Task 1 tests corners).
- A dribbler walking through a portal: the ball arrives with them, never on the far side on its own (Task 1 portal test,
  Task 3 test that a held ball follows a dribbler whose pose crossed a portal).
- Two people pressing E at once: one gets it, the other's screen shows a refusal and falls back (Task 3, Task 5).
- The dribbler disconnects and resumes, or leaves: hold kept through a resume, released on expire/leave (Task 3).
- A dribbler pressing Space faster than `BALL_KICK_GAP_MS`: the throw obeys the kick gap, and a refused throw keeps the
  ball held on both sides (Task 3, Task 5).

---

### Task 1: Hold spot geometry (shared)

**Files:**
- Create: `packages/shared/src/objects/ball/hold.ts`, `packages/shared/src/objects/ball/hold.test.ts`
- Modify: the shared package's ball exports (wherever `kickBall` is exported from `@zoom3d/shared`)

**Interfaces:**
- Produces: `HOLD_FORWARD_TILES`, `HOLD_SIDE_TILES`,
  `holdSpot(map: GameMap, portals: Portals | null, x: number, y: number, eyeAngle: number, out: { x: number; y: number }): { x: number; y: number }`
  (returns `out`).

- [ ] **Step 1: Write failing tests** in `hold.test.ts`:
  - `in open floor it sits half a tile ahead and a fifth to the right`: player at an open cell centre, angle 0 →
    `out` ≈ `(x + 0.5, y + 0.2)` (right of +x facing is +y in this map's screen axes; confirm against `PLAYER_RADIUS`
    tests in `geometry/movement` and flip the sign if the project's "right" is −y).
  - `facing a wall it is pulled back so the ball clears it`: player 0.4 tiles from a wall, facing it → distance from
    `out` to the wall face ≥ `BALL_RADIUS`, and `out` lies on the segment from the player to the free spot.
  - `in a corner it never ends inside a wall`: sweep `eyeAngle` over 32 steps in a corner cell; every result has no wall
    within `BALL_RADIUS` (use `isWallAt` on the four extreme points).
  - `a spot across a portal plane is pulled back to this side`: with a wired portal (use the fixture the
    `portals/crossing` tests use), the player 0.3 tiles before the plane facing it → `crossedPortal` from player to
    `out` reports no crossing.
  - `it allocates nothing`: the same `out` object is returned.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/objects/ball/hold.test.ts` → FAIL (no module).
- [ ] **Step 3: Implement `holdSpot`.** Target = player + rotated offset. If the ball circle at the target touches a wall
  or the segment crosses a portal (`crossedPortal`), bisect along the segment player→target (8 iterations) for the
  furthest clear point. The player's centre is always clear.
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `Place a dribbled ball at the player's hand`.

### Task 2: Protocol

**Files:**
- Modify: `packages/shared/src/protocol/protocol.ts`, its test file

**Interfaces:**
- Produces: `DribbleMessage = { type: 'dribble' }`, `ReleaseMessage = { type: 'release' }` in `ClientMessage`;
  `{ type: 'dribble_refused' }` in `ServerMessage`; `ObjectInfo.heldBy?: string`; `object_state.heldBy?: string`;
  `PROTOCOL_VERSION = 7`.

- [ ] **Step 1: Failing tests:** `dribble` and `release` parse to themselves; `dribble_refused` parses; an
  `object_state` and a welcome object with `heldBy: 'p1'` keep it; a non-string `heldBy` is dropped (absent);
  `PROTOCOL_VERSION` is 7.
- [ ] **Step 2: Run** the protocol tests → FAIL.
- [ ] **Step 3: Implement** the types and parsers beside `kick`/`kick_refused`; bump the version.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck` passes (switches over `ClientMessage` may need a case: route in Task 3).
- [ ] **Step 5: Commit** `Add dribble and release to the protocol`.

### Task 3: Server holds the ball

**Files:**
- Modify: `apps/server/src/lobby.ts`, `apps/server/src/server.ts` (route `dribble`, `release` beside `kick`),
  `apps/server/src/lobby.test.ts`

**Interfaces:**
- Consumes: `holdSpot` (Task 1), protocol (Task 2).
- Produces: `Lobby.dribble(conn: string): void`, `Lobby.release(conn: string): void`; `object_state` and the welcome's
  ball carry `heldBy` while held.

Keep the holder per room (e.g. `private readonly holders = new Map<string, string>()`, room id → peer id).

- [ ] **Step 1: Failing tests** (lobby with `ball: true`, `ballMind: true` where the mind matters):
  - `a dribble in reach holds the ball for the asker`: next tick's `object_state` has `heldBy` = asker id and `x, y` =
    `holdSpot` from the asker's pose.
  - `a dribble out of reach, while riding, or of a ball someone holds is refused`: each gets `dribble_refused`.
  - `a held ball follows its dribbler's walking and turning`: send poses moving and turning; each tick's ball is the
    hold spot of the latest pose, and its `vx, vy` are the dribbler's.
  - `a held ball follows a dribbler through a portal` (portals on).
  - `a held ball's mind sleeps`: a scared ball picked up broadcasts `mood: 'asleep'`, no cry, while held.
  - `release lets it roll on with the dribbler's motion`: after `release`, `heldBy` is absent and the ball moves by
    physics from the hold spot with the dribbler's velocity.
  - `a dribbler's kick throws it from the hand`: `heldBy` cleared, velocity = `BALL_KICK_SPEED` along the angle, echo
    with `by`/`k`; a kick inside the kick gap is refused and the ball stays held.
  - `another person's kick steals it`: release + normal kick.
  - `a moving person walking into it steals it; a still one does not`.
  - `the vacuum does not touch a held ball`.
  - `ride from a dribbler is refused`.
  - `the hold survives a disconnect within grace and ends on expire or leave`.
  - `a snapshot saves a held ball as not held`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/lobby.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `dribble`: on foot, nobody holds, `seenFrom` distance ≤ `BALL_KICK_REACH + KICK_SLACK_TILES`,
  else `dribble_refused`; on yes set the holder and the mind to `createBallMind()`. In `stepBalls`, a held ball skips
  the mind and `stepBall`: first check steals (another connected moving person overlapping it), else place it with
  `holdSpot` from the dribbler (in the ball's frame, as `seenFrom` gives), set `vx, vy` from the dribbler, and broadcast
  when it moved (with `heldBy`). `kick` from the holder releases first then kicks; from anyone else releases then kicks.
  `ride` returns early for a holder. `expire` releases. The welcome's ball info carries `heldBy`.
- [ ] **Step 4: Run** → PASS; `pnpm bench:tick` shows no regression against main (note numbers in the PR).
- [ ] **Step 5: Commit** `Let the server hold the ball for a dribbler`.

### Task 4: The drawn dribble bounce

**Files:**
- Create: `apps/web/src/game/ball-dribble.ts`, `apps/web/src/game/ball-dribble.test.ts`
- Modify: `apps/web/src/game/ball-hop.ts` (an entry to start a fall from a given height)

**Interfaces:**
- Produces: `DRIBBLE_PERIOD_S`, `DRIBBLE_HAND_TILES`, `createBallDribble(): BallDribble`,
  `stepBallDribble(d: BallDribble, dt: number): boolean` (true on the step it touches the floor),
  `d.liftTiles`; `dropFrom(hop: BallHop, liftTiles: number): void` in `ball-hop.ts`.

- [ ] **Step 1: Failing tests:** lift stays in `[0, DRIBBLE_HAND_TILES]`; one floor touch per `DRIBBLE_PERIOD_S`
  over 10 s at dt 1/60 (20 ± 1); it moves fastest at the floor (|Δlift| largest in the step around a touch); `dropFrom`
  makes a hop that falls from the given height and rebounds by `REBOUND_HEIGHT_SHARE`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** as a bounce `lift = H · (1 − (2·phase − 1)²)` over each period (a parabola: fastest at the
  floor), starting at the hand.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `Draw the dribble's bounce`.

### Task 5: Prediction and session

**Files:**
- Modify: `apps/web/src/game/ball-prediction.ts` (+test), `apps/web/src/net/session.ts` (+test),
  `apps/web/src/game/room.ts`, `apps/web/src/game/room-loop.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4.
- Produces on `BallPrediction`: `readonly heldBy: string | null`; `pickUp(from: Point, now: number): boolean`;
  `letGo(now: number): void`; `dribbleRefused(now: number): void`;
  `holdAt(x: number, y: number, eyeAngle: number, out: Point): Point`; `step(dt, now, self, eyeAngle: number)` (new
  param). On `Session`: `sendDribble()`, `sendRelease()`, handler `dribbleRefused()`. On `Room`: `dribble(): void`
  (picks up or lets go), and `kick()` throws while held.

- [ ] **Step 1: Failing prediction tests:**
  - `a pick-up in reach holds it at once at the hand`: after `pickUp`, `step` puts `ball` at `holdSpot` of `self` and
    `eyeAngle`, and `heldBy` is the local id once the server says so.
  - `turning swings it`: the same `self`, `eyeAngle` changes → ball moves to the new hold spot on the next step.
  - `refused falls back to the server's ball`.
  - `another's hold stops local physics`: an `object_state` with `heldBy: 'other'` → `heldBy` is `'other'` and a
    local body walking into it does not push it.
  - `a throw leaves from the hand and waits for the echo`; `a let-go rolls on with the local velocity`.
  - `held, the lift is the dribble's; on release it falls from where it was` (no jump in `lift`).
  - `the mood shown while held is asleep`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the held mode in `ball-prediction.ts`; session methods and `heldBy` on `object_state`;
  `Room.dribble` sends `dribble`/`release`; `Room.kick` sends the throw as a kick; room-loop passes `localPlayer.eye()`
  as `eyeAngle` and plays the dribble's floor touches as the ball's `bounce` through `objectSounds` at
  `DRIBBLE_BOUNCE_GAIN = 0.5` of a bounce (add an optional gain to `localEvent`; tune by ear).
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `Predict the dribble on the dribbler's screen`.

### Task 6: Others see the ball at the dribbler's hand

**Files:**
- Modify: `apps/web/src/game/remote-world.ts` (+test), the own held-item drawing wherever `localPlayer.riding` hides it

**Interfaces:**
- Consumes: `ShownBall` gains `heldBy` and `holdAt` from `BallPrediction` (Task 5).

- [ ] **Step 1: Failing tests:** with a ball `heldBy` a remote peer, the ball's `objectPoses` entry equals `holdAt` of
  that peer's drawn position and heading in the same `sample` (peers sampled first); the dribbler's sprite `held` is
  null while dribbling and comes back after; the local player's own held item is hidden while dribbling.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement:** in `sample`, place a remotely held ball after `samplePeers`; hide `sprite.held` (and the
  lighter glow, as riding does) for the dribbler; no new per-frame allocation.
- [ ] **Step 4: Run** → PASS; `pnpm bench:sprites` hashes unchanged.
- [ ] **Step 5: Commit** `Draw a dribbled ball at its dribbler's hand`.

### Task 7: E, Space, touch and hint

**Files:**
- Create: `apps/web/src/game/use-key.ts`, `apps/web/src/game/use-key.test.ts`
- Modify: `apps/web/src/input/room-keys.ts` (+test: rename kind `ride` → `use`), `apps/web/src/game/room-controls.ts`,
  `apps/web/src/game/scooter-ride.ts` (expose `nearestDistance(player, apparent?): number | null`),
  `apps/web/src/ui/touch-controls.ts`

**Interfaces:**
- Produces: `chooseUse(s: { riding: boolean; dribbling: boolean; ballTiles: number | null; scooterTiles: number | null }): 'dismount' | 'letGo' | 'dribble' | 'ride' | null`.

- [ ] **Step 1: Failing tests:** riding → `dismount` even with the ball nearer; dribbling → `letGo` even with a scooter
  in reach; on foot the nearer of ball and scooter wins; nothing in reach → null; `roomKey` E → `{ kind: 'use' }`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement:** room-controls calls `chooseUse` and acts; the hint reads `E: dribble`, `E: let go` or
  `E: ride`; the touch scooter button becomes "use", showing the ball icon (`touchIcon('ball')`) when the choice is the
  ball, the scooter icon otherwise, with label `Dribble the ball` / `Let go` / `Ride a scooter`.
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `Choose what E does: ride, dribble or let go`.

### Task 8: Docs and in-game check

**Files:**
- Modify: `AGENTS.md` (gotcha: held ball drawn from the dribbler's pose, never interpolated; `heldBy`), the ball spec's
  pointer line (`2026-10-23-ball-design.md` §1, as D33 has), `docs/open-decisions.md` D37 builder's calls.

- [ ] **Step 1:** Write the doc lines.
- [ ] **Step 2: Verify in game:** `pnpm dev`, the same room link in two tabs, pick up with E, walk, turn, let go,
  throw, steal from the other tab, walk into a wall and through a portal. Screenshot the dribble.
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test` all pass.
- [ ] **Step 4: Commit** `Document the dribble`.
