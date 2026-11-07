# Kick Scooters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every room has a rack of 4 kick scooters. Anyone steps on one with E, rides forward at 6 tiles/s, and steps
off with E. The scooter stays where it was left.

**Architecture:** Parked scooters are server-owned world objects (`ObjectKind` `'scooter'`). A ridden scooter is not
an object. It is `riding: <scooterId>` on its rider's `Peer`/`PeerInfo`, and clients draw it under the rider from the
rider's own drawn pose. One server message, `peer_ride`, moves a scooter between the two states for everyone.

**Tech Stack:** TypeScript, pnpm workspace, vitest, Biome, Playwright; Canvas2D voxel renderer.

**Spec:** `docs/superpowers/specs/2026-11-07-kick-scooter-design.md`

## Global Constraints

- `RIDE_SPEED = 6` tiles/s, forward only. Backward, strafe and turning stay at `MOVE_SPEED` (3) and `TURN_SPEED`.
- `MOUNT_REACH = 1` tile, rider centre to scooter centre. `SCOOTER_COUNT = 4`.
- Move check: ride limit while riding and for `RIDE_GRACE_MS = 1000` after stepping off.
- The ball's `BODY_MAX_SPEED` stays `MOVE_SPEED * 1.5`.
- `PROTOCOL_VERSION` 5 → 6. `LobbySnapshot` stays version 1, and `SnapshotPeer` omits `riding`.
- E (`KeyE`) toggles riding. Q/E no longer turn.
- No collisions with parked scooters. No sounds, no automap, no first-person handlebar, no bot riders.
- With no scooters in a scene, every `bench:walls` / `bench:sprites` hash is unchanged.
- House style:
  - Biome (`pnpm exec biome check --write .`);
  - braced bodies;
  - `.at()` over `[i] as T`;
  - no "you/your" in identifiers;
  - comments only say why;
  - no allocations per frame.
- Commit messages: imperative mood, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Server lag on mount.** The server's last pose of the rider trails the client's by up to a tick (~0.4 tiles at
   walk). A mount the client saw in reach must not be refused. Accept within `MOUNT_REACH + MOUNT_SLACK_TILES` (0.5)
   on the server. Test in Task 3.
2. **E pressed again while a mount is in flight.** It must not send a second `ride` or a `dismount` for a ride that
   hasn't started. Pending state, test in Task 5.
3. **Reload while riding.** The resumed tab rides at once. The welcome's `riding` sets it, and the welcome does not
   list that scooter as parked. Tests in Tasks 3 and 4.
4. **Stepping off after crossing a portal.** The scooter parks at the rider's real `x, y` (where the server has them),
   never at an apparent position. Test in Task 3.
5. **Two people race for one scooter.** Exactly one `peer_ride` goes out, and the loser stays on foot with no error.
   Test in Task 3.

---

### Task 1: Scooter rules, ride speed and the move check (shared)

**Files:**
- Create: `packages/shared/src/objects/scooter/scooter.ts`, `packages/shared/src/objects/scooter/scooter.test.ts`
- Modify:
  - `packages/shared/src/geometry/movement.ts` (`stepPlayer`)
  - `packages/shared/src/protocol/movecheck.ts`
  - `packages/shared/src/index.ts` (export the new module)
- Test:
  - `packages/shared/src/geometry/movement.test.ts`
  - `packages/shared/src/protocol/movecheck.test.ts` (create it if it doesn't exist)

**Interfaces:**
- Produces:
  - `RIDE_SPEED = 6`, `MOUNT_REACH = 1`, `SCOOTER_COUNT = 4`, `RIDE_GRACE_MS = 1000`.
  - `interface ScooterPose { id: string; x: number; y: number; angle: number }`.
  - `rackSpots(map: GameMap): { x: number; y: number; angle: number }[]`: the 4 rack poses, at tile centres
    (37.5, 50.5), (38.5, 50.5), (39.5, 50.5), (40.5, 50.5), angle `-Math.PI / 2`. If the map isn't LEVEL1, any of
    those tiles that aren't floor are dropped.
  - `canMount(rider: Point, scooter: Point, slack = 0): boolean`: distance ≤ `MOUNT_REACH + slack`.
  - `interface ScooterSave { map: string; scooters: ScooterPose[] }`.
  - `saveScooters(map: GameMap, scooters: Iterable<ScooterPose>): ScooterSave`.
  - `restoreScooters(map: GameMap, save: unknown): ScooterPose[] | null`. It returns null for another
    `mapFingerprint`, a malformed save, or any pose in a wall.
  - `stepPlayer(map, s, input, dt, out, portals = null, forwardSpeed = MOVE_SPEED)`.
  - `isPlausibleMove(map, from, to, elapsedMs, portals = null, speed = MOVE_SPEED)`.

- [ ] **Step 1: Write the failing tests**
  - `scooter.test.ts`:
    - `rackSpots(parseMap(LEVEL1))` has length `SCOOTER_COUNT`; every spot has `tileAt === 0` and none is the spawn
      tile.
    - `canMount({x:0,y:0},{x:1,y:0})` is true; at `x: 1.01` it is false; `canMount(…, {x:1.4,y:0}, 0.5)` is true.
    - Save and restore round-trip `[{id:'a',x:38.5,y:50.5,angle:1}]`.
    - Restore returns null for a save with `map: 'other'`, and for one with a pose at (0.5, 0.5) (stone).
  - `movement.test.ts`:
    - With `forward: 1`, dt 0.1, `forwardSpeed: RIDE_SPEED` in an open room, the player moves 0.6 tiles.
    - With `forward: -1` it moves 0.3.
    - With `strafe: 1` it moves 0.3.
  - `movecheck.test.ts`:
    - 1.2 tiles in 100 ms is implausible at the default speed (limit 0.45 + 0.5 = 0.95).
    - 1.2 tiles in 100 ms is plausible with `speed: RIDE_SPEED` (limit 0.9 + 0.5 = 1.4).

- [ ] **Step 2: Run them and confirm they fail**

  Run: `pnpm --filter @zoom3d/shared exec vitest run src/objects/scooter src/geometry src/protocol/movecheck`

  Expected: FAIL (the module is missing; there are no `forwardSpeed`/`speed` parameters yet).

- [ ] **Step 3: Implement it**

  In `stepPlayer`, after normalising, scale `forward` by `forward > 0 ? forwardSpeed : MOVE_SPEED` and `strafe` by
  `MOVE_SPEED`, both × `t`, in place of the single `step`. Save and restore mirror `saveVacuum`/`restoreVacuum`, and
  use `mapFingerprint` from `objects/vacuum/nav`.

- [ ] **Step 4: Run the tests and `pnpm typecheck`**

  Expected: PASS. Bots still call `stepPlayer` without the new argument, unchanged.

- [ ] **Step 5: Commit** "Add scooter rules and a ride speed to movement and the move check"

### Task 2: Protocol (shared)

**Files:**
- Modify: `packages/shared/src/protocol/protocol.ts`
- Test: `packages/shared/src/protocol/protocol.test.ts`

**Interfaces:**
- Produces:
  - `PROTOCOL_VERSION = 6`.
  - `ObjectKind = 'vacuum' | 'ball' | 'scooter'`.
  - `PeerInfo.riding: string | null`.
  - `RideMessage = { type: 'ride'; id: string }` and `DismountMessage = { type: 'dismount' }`, both in
    `ClientMessage`.
  - The server message `{ type: 'peer_ride'; id: string; scooter: string } | { type: 'peer_ride'; id: string;
    scooter: null; parked: ObjectInfo }`, exported as `PeerRideMessage`.
  - The welcome gains `riding: string | null`.

- [ ] **Step 1: Write the failing tests**
  - `parseClientMessage({type:'ride', id:'s1'})` gives `{type:'ride', id:'s1'}`. `{type:'ride'}` with no id gives
    null. `{type:'dismount'}` round-trips.
  - `parsePeerInfo` of a peer without `riding` gives `riding: null`; with `riding: 's1'` it keeps it; with
    `riding: 5` it gives null.
  - `parseServerMessage` of `peer_ride`:
    - `scooter: 's1'` keeps it;
    - `scooter: null` with a valid `parked` scooter `ObjectInfo` keeps both;
    - `scooter: null` with no `parked` gives null.
  - A welcome without `riding` parses with `riding: null`. `parseObjectInfo({id:'s1', kind:'scooter', x, y, angle})`
    is accepted.
  - Use the parse function names `protocol.ts` already exports; match the existing test file's style.

- [ ] **Step 2: Run them and confirm they fail.**

  Run: `pnpm --filter @zoom3d/shared exec vitest run src/protocol`

- [ ] **Step 3: Implement it in `protocol.ts`, following `held`/`peer_held`.**

  Every literal `PeerInfo` in tests and in server code now needs `riding: null`. Fix them as `pnpm typecheck` lists
  them. Server: `peerInfo()` in `lobby.ts` returns `riding`, and `admit`/bot creation set `riding: null`.

- [ ] **Step 4: Run `pnpm test` and `pnpm typecheck`.** Expected: PASS.

- [ ] **Step 5: Commit** "Carry scooter rides in the protocol (version 6)"

### Task 3: The server's scooters

**Files:**
- Modify:
  - `apps/server/src/lobby.ts`
  - `apps/server/src/server.ts` (option `scooters: opts.scooters ?? true`; route `ride`/`dismount` next to `held`)
- Test: `apps/server/src/lobby.test.ts`, `apps/server/src/snapshot.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces:
  - `LobbyOptions.scooters?: boolean`.
  - `Lobby.ride(conn: string, msg: RideMessage): void` and `Lobby.dismount(conn: string): void`.
  - `Peer.riding: string | null` and `Peer.rodeUntil: number` (ms; 0 when never ridden).
  - `LobbySnapshot.rooms[].scooters?: ScooterSave`.
  - `MOUNT_SLACK_TILES = 0.5` (in `lobby.ts`).

**Behaviour:**

- *Rooms:*
  - `private readonly scooters = new Map<string, Map<string, ScooterPose>>()`, keyed by room id.
  - `openRoom` fills it from `rackSpots` with `newToken()` ids when `opts.scooters` is set.
  - `closeRoom` deletes it.
  - The welcome lists parked scooters as `{ id, kind: 'scooter', x, y, angle }` and sets `riding: peer.riding`.
- *`ride`:* it is accepted only if all of these hold:
  - `peer.riding === null`;
  - the scooter is parked in the peer's room;
  - `canMount(this.seenFrom(portals, scooter, peer), scooter, MOUNT_SLACK_TILES)`.

  An accepted ride deletes the scooter from parked, sets `peer.riding = id` and broadcasts
  `{type:'peer_ride', id: peer.id, scooter: id}` to the whole room, the rider included. A refused ride sends nothing.
- *`dismount`:* if `peer.riding` is set, the scooter is parked at `{x: peer.x, y: peer.y, angle: peer.angle}`,
  `riding` is cleared, `rodeUntil = now + RIDE_GRACE_MS`, and `peer_ride` goes out with `scooter: null` and
  `parked`, to everyone.
- *The speed limit:* one `private speedLimit(peer, now)` returns `RIDE_SPEED` when
  `peer.riding !== null || now < peer.rodeUntil`, else `MOVE_SPEED`. It is passed to every `isPlausibleMove` call,
  both the move check in `isPlausibleInRoom` and the `walked` test for `vx/vy`.
- *`expire`:* if the peer was riding, the scooter is parked at their last pose before `peer_left`, and `peer_ride`
  (`scooter: null`) is broadcast first, so the remaining people see the scooter. A peer in its resume grace keeps
  `riding`.
- *Snapshot:*
  - `snapshot()` saves `saveScooters(map, [...parked, ...riders' scooters at their poses])`;
  - `savePeer` drops `riding` and `rodeUntil`;
  - `restore` sets every peer's `riding: null` and restores the scooters (`restoreScooters`, falling back to a fresh
    rack on null);
  - `SnapshotPeer` is `Omit<PeerInfo, 'slot' | 'riding'>`.

- [ ] **Step 1: Write the failing tests** (in `lobby.test.ts`, with `scooters: true` on a test lobby; follow the
  file's existing helpers for joining and sending state):
  - The welcome lists 4 `kind: 'scooter'` objects, and `riding: null`.
  - **Mount in reach.** A peer moved to within 1.3 tiles of a scooter sends `ride`. Everyone, sender included,
    receives `peer_ride` with that scooter. A newcomer's welcome then lists 3 scooters and that peer with
    `riding: id`.
  - **Mount refused.** At 2 tiles, `ride` sends nothing and changes nothing.
  - **Race.** Two peers in reach both send `ride` for the same id. Exactly one `peer_ride` with a scooter goes out, and
    the second peer's `riding` stays null.
  - **Already riding.** A second `ride` while riding is ignored.
  - **Speed.** A rider's state 1.2 tiles further after 100 ms is accepted, with no `correction`. The same move on foot
    gets a `correction`.
  - **Grace.** 500 ms after `dismount`, a 1.2-tile/100 ms move is still accepted. At 1500 ms it is corrected.
  - **Dismount.** The scooter is parked at the rider's server pose and angle, and `peer_ride` carries `parked`.
  - **Portal crossing.** With portals on, a rider steps through a doorway (an accepted move), then dismounts. `parked`
    equals the peer's stored `x, y`.
  - **Expiry.** A riding peer whose grace runs out: the room gets `peer_ride` (`scooter: null`, `parked` at their
    pose) before `peer_left`.
  - **Resume.** A riding peer reconnects within grace: its welcome has `riding: id` and lists only the other 3
    scooters.
  - **Ball.** A rider moving at 6 tiles/s into the ball pushes it no faster than `BALL_PUSH_MAX_SPEED`.
  - **Bots.** With `bots: 3`, every bot's `riding` is null.
  - `snapshot.test.ts`:
    - a room with one rider and 3 parked scooters round-trips to 4 parked scooters, with the rider's at their pose and
      the rider on foot;
    - a snapshot without `scooters` restores a fresh rack.

- [ ] **Step 2: Run them and confirm they fail.**

  Run: `pnpm --filter @zoom3d/server exec vitest run src/lobby.test.ts src/snapshot.test.ts`

- [ ] **Step 3: Implement the behaviour above in `lobby.ts` and the routing in `server.ts`.** Message rate limits
  follow `held`'s handling in `server.ts`.

- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck` and `pnpm bench:tick`.** Expected: PASS, and tick times within noise
  of `main`.

- [ ] **Step 5: Commit** "Park, ride and save scooters on the server"

### Task 4: The client session

**Files:**
- Modify: `apps/web/src/net/session.ts`
- Test: `apps/web/src/net/session.test.ts`

**Interfaces:**
- Consumes: the protocol from Task 2.
- Produces:
  - `Session.riding: string | null` (the local player's own; from the welcome, then from its own `peer_ride`).
  - `Session.sendRide(id: string): void` and `Session.sendDismount(): void`, both through `sendWhileOpen`.
  - `RemotePeer.info.riding` is kept current.
  - `SessionListener.peerRide?(peerId: string, scooter: string | null): void`, called for the local player and for
    others.

**Behaviour:**

- `peer_ride` with a scooter deletes `objects.get(scooter)` (and its buffer).
- `peer_ride` with `scooter: null` adds `parked` exactly as the welcome adds an object.
- In either case the peer's `info.riding` updates, or `Session.riding` when `id === selfId`.

- [ ] **Step 1: Write the failing tests** (follow the existing fake-WebSocket tests in `session.test.ts`):
  - A welcome with `riding: 's1'` sets `session.riding` to `'s1'`.
  - `peer_ride` for another peer with `scooter: 's2'` removes object `s2` and sets that peer's `info.riding`.
  - `peer_ride` with `scooter: null, parked: {id:'s2', kind:'scooter', …}` brings `s2` back into `objects` at that
    pose and clears `riding`.
  - Own `peer_ride` sets and clears `session.riding`, and `peerRide` is called with `selfId`.
  - `sendRide('s1')` sends `{type:'ride', id:'s1'}`.

- [ ] **Step 2: Run them and confirm they fail.**

  Run: `pnpm --filter @zoom3d/web exec vitest run src/net/session.test.ts`

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run the tests and `pnpm typecheck`.** Expected: PASS.

- [ ] **Step 5: Commit** "Follow scooter rides in the client session"

### Task 5: Riding controls: E, the speed, the touch button and the hint

**Files:**
- Create: `apps/web/src/game/scooter-ride.ts`, `apps/web/src/game/scooter-ride.test.ts`
- Modify:
  - `apps/web/src/input/keyboard.ts` (remove the `KeyQ`/`KeyE` bindings) and `keyboard.test.ts` (the "arrows and
    Q/E turn" case becomes "arrows turn; Q and E don't")
  - `apps/web/src/input/room-keys.ts` (+ test): `KeyE`, not repeating and not a shortcut, gives `{ kind: 'ride' }`
    while in the room
  - `apps/web/src/game/room-controls.ts` (`case 'ride'`; touch state `scooter`)
  - `apps/web/src/ui/touch-controls.ts` (+ test): a "Scooter" `iconButton` shown while `s.scooter`, pressed on
    `pointerdown` like the kick button
  - `apps/web/src/ui/icons.ts`: a `scooter` icon
  - `apps/web/src/game/local-player.ts`: `walk` takes the forward speed
  - `apps/web/src/game/room.ts`: the wiring
  - the hint: a small `#ride-hint` element in `ui/room-screen.ts`, with CSS next to the existing room overlays

**Interfaces:**
- Consumes:
  - `Session.riding`, `sendRide`, `sendDismount` and `objects` (Task 4);
  - `canMount`, `RIDE_SPEED`, `MOVE_SPEED` (Task 1);
  - the apparent positions of objects (`apparent-world.ts`, as the ball's kick reach uses).
- Produces: `createScooterRide(session: Pick<Session, 'riding' | 'sendRide' | 'sendDismount' | 'objects'>, now: () =>
  number)` returning:
  - `toggle(player: Point, apparent?: ReadonlyMap<string, Apparent>): void`;
  - `inReach(player: Point, apparent?): boolean`: a parked scooter is within `MOUNT_REACH`, on foot, and nothing
    is pending;
  - `forwardSpeed(): number`: `RIDE_SPEED` while `session.riding !== null`, else `MOVE_SPEED`;
  - `settled(): void`, called from the session's own `peerRide` to clear the pending state.

**Behaviour:**

- `toggle` on foot sends `ride` for the **nearest** parked scooter within `MOUNT_REACH`, then marks itself pending.
- `toggle` while riding sends `dismount` and marks itself pending.
- While pending, `toggle` does nothing. Pending clears on `settled()` or after `RIDE_PENDING_MS = 1000`.
- The speed follows only `session.riding`, never the pending state.
- The hint shows the text `E: ride` while `inReach` holds and the device isn't touch, and is hidden otherwise. Touch
  shows the button instead, while `inReach` holds **or** while riding.

- [ ] **Step 1: Write the failing tests**
  - `scooter-ride.test.ts`, with a fake session:
    - **Nearest.** On foot with two scooters at 0.6 and 0.9 tiles, `toggle` sends `ride` for the 0.6 one.
    - **Nothing in reach.** At 1.2 tiles it sends nothing.
    - **Pending.** A second `toggle` right after sends nothing. After `settled()` with `riding` set, `toggle` sends
      `dismount`.
    - **Timeout.** With no answer, after 1000 ms `toggle` sends `ride` again.
    - **Speed.** `forwardSpeed()` is 3 on foot and 6 once `riding` is set.
    - **Hint.** `inReach` is false while riding.
  - `room-keys.test.ts`: `KeyE` gives `{kind:'ride'}`; repeating, or with `ctrlKey`, gives null.
  - `keyboard.test.ts`: `KeyQ`/`KeyE` give `turn: 0`.
  - `touch-controls.test.ts`: the scooter button is hidden until `update({..., scooter: true})`.

- [ ] **Step 2: Run them and confirm they fail.**

  Run: `pnpm --filter @zoom3d/web exec vitest run src/game/scooter-ride.test.ts src/input src/ui/touch-controls.test.ts`

- [ ] **Step 3: Implement it.**

  `local-player.walk(map, move, turnRad, dt, portals, forwardSpeed = MOVE_SPEED)` passes it to `stepPlayer`.
  `room.ts` calls `walk` with `ride.forwardSpeed()`. Touch state and the hint refresh where `kickInReach` refreshes
  today.

- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck` and `pnpm lint`.** Expected: PASS.

- [ ] **Step 5: Commit** "Ride scooters with E or the touch button; Q and E no longer turn"

### Task 6: Drawing scooters

**Files:**
- Create: `apps/web/src/renderer/models/scooter.ts`
- Modify:
  - `apps/web/src/game/remote-world.ts` (+ test)
  - `apps/web/src/renderer/sprites.ts`: a `Sprite.ride: number` lift in tiles, 0 on foot
  - the portal-window self path where `RoomScene.self` is filled
  - `apps/web/src/renderer/walls.bench.ts` and the sprites bench: a scooter scene

**Interfaces:**
- Consumes: `ObjectKind 'scooter'` and `RemotePeer.info.riding`.
- Produces:
  - `SCOOTER_MODEL: VoxelModel`: deck, two wheels, stem and handlebar, about 0.6 tiles long and 0.55 tall, with its
    front along +x;
  - `SCOOTER_DECK_TILES = 0.06`: the deck's top above the floor, and the rider's lift.

**Behaviour:**

- `collectVoxels`: a parked scooter gets `SCOOTER_MODEL`. The model choice becomes a lookup by `ObjectKind`, not a
  ternary.
- After the objects, every riding peer adds a pooled `VoxelInstance` with `SCOOTER_MODEL` at that peer's sampled
  position, `angle` = their drawn angle and `lift` 0. That puts it on the same list that walls (shadows, the mirror)
  and sprites take.
- A riding peer's sprite has `bob: 0`, `itemBob: 0` and `ride: SCOOTER_DECK_TILES`. `renderSprites` lifts the disc
  centre by `ride` (in the same units as the bob lift), and its shadow stays on the floor.
- The local player riding: a scooter instance at their pose and a lifted disc, added **only** where window passes
  receive `RoomScene.self`. The main pass never draws them.

- [ ] **Step 1: Write the failing tests** in `remote-world.test.ts`:
  - **Parked.** A session with one parked scooter yields one voxel with `SCOOTER_MODEL`.
  - **Ridden.** A riding peer yields a scooter voxel at that peer's sampled position and angle, and their sprite has
    `bob: 0` and `ride: SCOOTER_DECK_TILES`.
  - **Pooling.** Two frames reuse the same voxel objects (`toBe`).

- [ ] **Step 2: Run them and confirm they fail.**

  Run: `pnpm --filter @zoom3d/web exec vitest run src/game/remote-world.test.ts`

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Check the benchmark hashes**

  Run `pnpm bench:walls` and `pnpm bench:sprites` on `main` (`git stash` or a worktree) and on the branch. Every
  existing hash must be identical. Add a scene with 2 parked scooters and 1 rider, and record its hash in the D36
  entry.

- [ ] **Step 5: Look at it in the game.** Run `pnpm dev`, open a room with two tabs, ride in one, and check the other:
  - the scooter sits under the face, not sliding;
  - it has a lamp shadow and a floor reflection;
  - it is seen through a portal window;
  - a parked one is left behind on E.

  Take a screenshot for the PR.

- [ ] **Step 6: Commit** "Draw parked and ridden scooters"

### Task 7: E2E and the docs

**Files:**
- Create: `apps/web/e2e/scooter.spec.ts`
- Modify: `docs/open-decisions.md` (a new **D36 — Kick scooters**, Resolved 2026-11-07) and `AGENTS.md`

- [ ] **Step 1: Write `scooter.spec.ts`** using `e2e/join.ts` helpers. Use `window.__game` (dev-only) to read
  positions and objects, extending it with `riding` if needed.
  - A and B join one room.
  - A's pose is set beside rack scooter 1, then A presses E.
  - Within 2 s, A's `__game` reports riding, and B's world shows A riding with 3 parked scooters.
  - A holds W for 1 s and covers over 4.5 tiles. Walking would give at most 3.
  - A presses E. B's world shows 4 parked scooters, one at A's position.

- [ ] **Step 2: Run** `pnpm e2e -- scooter.spec.ts`. Expected: PASS. Then run the whole `pnpm e2e`: the existing
  specs mustn't rely on Q/E (grep `KeyQ\|KeyE\|'q'\|'e'` in `apps/web/e2e`; replace any use with arrow keys).

- [ ] **Step 3: Write the docs**
  - D36 summarises the spec:
    - approach B and why;
    - the speeds and the grace;
    - stays where dropped;
    - E, and Q/E turning removed (the owner, 2026-11-07);
    - what's left out;
    - the new bench hash.
  - AGENTS.md gets a "Kick scooters (D36, spec …)" gotcha with these points:
    - a ridden scooter is drawn from its rider, never as an object;
    - the move check's speed comes from `speedLimit` (`riding` plus the grace);
    - the ball's body cap stays at walking × 1.5;
    - scooters are saved in the state file, and riders come back on foot.

- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck` and `pnpm lint`.** Expected: PASS.

- [ ] **Step 5: Commit** "Test scooter rides end to end and record D36"
