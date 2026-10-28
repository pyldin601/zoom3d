# Portal Doorways Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A room-wide Y toggle that turns every one-tile doorway into a one-way portal (fixed per room), with drawing,
walking, contacts, sound, faces and fan-out all agreeing.

**Architecture:** A new `packages/shared/src/portals/` module owns doorways, the per-room wiring, rigid transforms,
plane crossings, a portal-aware ray, line of sight and "apparent position". Everything else takes a
`portals: Portals | null` (null = mode off, today's behaviour, bit for bit). The server owns the flag per room; the
client draws portals by re-running its passes from a virtual eye into a scratch framebuffer and copying the window.

**Tech Stack:** TypeScript, Vitest, Biome, Playwright, Node `ws` server, software framebuffer renderer.

**Spec:** `docs/superpowers/specs/2026-10-28-portal-doorways-design.md`

## Global Constraints

- `portals === null` must be exactly today's behaviour: same results in every test, same pixels (bench pixel hashes).
- No allocations in the per-frame or per-column path; scratch is sized when the frame's size changes.
- Every `if`/`else`/`for`/`while` body braced; Biome style; `.at()` over `arr[i] as T`; names over comments
  (docs/code-style.md); no "you/your" in identifiers, comments or test titles.
- Doorway: floor tile, walls on exactly two opposite sides, floor on the other two. level1 has 24.
- Recursion depth 2; beyond it a window is filled black (`0xff000000`).
- Toggle rate limit: at most one flip per room per 1000 ms. Movecheck grace after a flip: 1000 ms.
- Apparent position: up to 2 portals, only portals whose front faces the listener and whose centre is within
  `NEAR_TILES` (16).
- `PROTOCOL_VERSION` 3 → 4. Snapshot stays `version: 1` (new field optional, defaults off).
- Notice copy, exactly: `Portals on` / `Portals off`.
- Telemetry never carries room ids, names, tokens or IPs.

## Review Focus

1. **A step that crosses a plane while sliding along the doorway's side wall** (player radius 0.25 in a 1-tile gap):
   the player must come out at the destination, never stick or end inside a wall. Test in Task 2.
2. **Toggling while someone stands in a doorway tile, on either side of its plane:** nobody moves, nobody is
   corrected, and the next step behaves per the new mode. Tests in Tasks 2 and 6.
3. **Looking at a doorway edge-on or from its back side with portals on:** no window, no flicker, ordinary view.
   Test in Task 4.
4. **Two doorways wired to each other's neighbourhoods, seen through each other (depth 2, then 3):** depth 3 is black,
   not garbage from the previous frame. Test in Task 11.
5. **A late `state` from before a flip, and a peer's pose pair that straddles a jump:** no correction, no glide
   across the map. Tests in Tasks 6 and 9.

---

### Task 1: Doorways, wiring and transforms

**Files:**
- Create: `packages/shared/src/portals/doorways.ts`, `packages/shared/src/portals/wiring.ts`,
  `packages/shared/src/portals/transform.ts`
- Test: `packages/shared/src/portals/doorways.test.ts`, `packages/shared/src/portals/wiring.test.ts`,
  `packages/shared/src/portals/transform.test.ts`
- Modify: `packages/shared/src/index.ts` (export the three)

**Interfaces:**
- Produces:
  ```ts
  export interface Doorway { x: number; y: number; axis: 'ns' | 'we' } // 'ns': passage runs north–south
  export function findDoorways(map: GameMap): Doorway[]; // row-major order
  export interface RigidTransform { cos: number; sin: number; tx: number; ty: number } // p' = R·p + t, R a multiple of 90°
  export function applyPoint(t: RigidTransform, x: number, y: number, out: { x: number; y: number }): typeof out;
  export function applyDir(t: RigidTransform, dx: number, dy: number, out: { x: number; y: number }): typeof out;
  export function applyAngle(t: RigidTransform, angle: number): number; // normalised to [0, 2π)
  export function invert(t: RigidTransform): RigidTransform;
  export interface Portal {
    door: Doorway;
    cx: number; cy: number;       // plane centre (tile centre)
    nx: number; ny: number;       // unit normal, front → back
    to: number;                   // destination portal index
    toDest: RigidTransform;       // this doorway's space → destination's
    fromDest: RigidTransform;     // its inverse
  }
  export interface Portals { map: GameMap; list: Portal[]; byTile: Int32Array } // byTile: tile index → portal, −1
  export function roomSeed(roomId: string): number; // FNV-1a 32-bit
  export function wirePortals(map: GameMap, roomId: string): Portals;
  ```

- [ ] **Step 1: Write the failing tests**
  - `findDoorways(parseMap(LEVEL1))` has length 24 and contains `{ x: 34, y: 8, axis: 'ns' }` and
    `{ x: 28, y: 4, axis: 'we' }`; a 3-wide corridor map yields `[]`.
  - `wirePortals(map, 'abc')` twice gives equal `to` and normals; `'abd'` gives a different `to` list.
  - every `to !== i`, and the `to` values are a permutation of `0..n−1`.
  - `toDest` maps portal i's centre onto its destination's centre and its normal onto the destination's normal
    (`applyDir`), with `|cos|,|sin| ∈ {0, 1}` exactly; `applyPoint(fromDest, applyPoint(toDest, p)) ≈ p`.
  - `byTile` at each doorway's tile index is its portal index, −1 elsewhere.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/portals`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** Front per doorway: `rng() < 0.5` picks the sign of the normal. Destinations: Sattolo's
  shuffle with `seeded(roomSeed(roomId))` (a single cycle, so no fixed points). Rotation from the angle between the two
  normals, with cos/sin taken from the integer normals (no `Math.cos`), then `t = c_dest − R·c_src`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Find doorways and wire them into portals per room"`

### Task 2: Crossing a plane, and walking through it

**Files:**
- Create: `packages/shared/src/portals/crossing.ts`; Test: `packages/shared/src/portals/crossing.test.ts`
- Modify: `packages/shared/src/geometry/movement.ts` (`stepPlayer`), `movement.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  /** The first portal whose plane a→b crosses front→back inside its opening, or −1; `out.t` its fraction along a→b. */
  export function crossedPortal(p: Portals, ax: number, ay: number, bx: number, by: number, out: { t: number }): number;
  /** Carries a pose that just moved from (ax, ay) through the portal it crossed, if any; also rotates `vel`. */
  export function carryThroughPortal(
    p: Portals | null, ax: number, ay: number,
    pose: { x: number; y: number; angle: number }, vel?: { vx: number; vy: number }
  ): boolean;
  export function stepPlayer(map, s, input, dt, out, portals: Portals | null = null): PlayerState;
  ```

- [ ] **Step 1: Write the failing tests** (on a small hand-made map with two doorways wired to each other via a
  fixture `Portals`, not level1):
  - a segment crossing A's plane back→front returns −1; front→back returns A with `t` at the plane.
  - a segment crossing the plane line outside the opening (through the side wall's line) returns −1.
  - `stepPlayer` walking front→back through A, with `portals`, ends on B's back side, angle rotated by A's
    transform; the same input with `null` ends exactly where today's code does.
  - Review focus 1: start 0.05 tiles from A's side wall, strafing into it while walking through: comes out at B, not
    in a wall (`isWallAt` false).
  - Review focus 2: a pose standing exactly in A's tile on its front half, stepping with zero input, never jumps.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/portals packages/shared/src/geometry`. Expected: FAIL.
- [ ] **Step 3: Implement.** `crossedPortal` walks the tiles a→b with the DDA from `los.ts` and checks `byTile`;
  inside a doorway tile, the plane fraction is solved on the doorway's axis. `carryThroughPortal` moves the remainder
  of the segment past the plane through `toDest`. `stepPlayer` calls it after `moveWithCollision`.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Walk through portals"`

### Task 3: Line of sight and apparent position

**Files:**
- Create: `packages/shared/src/portals/apparent.ts`; Test: `packages/shared/src/portals/apparent.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2, `hasLineOfSight`, `NEAR_TILES`.
- Produces:
  ```ts
  /** As hasLineOfSight, but false when the straight segment crosses a plane front→back. */
  export function hasPortalLineOfSight(p: Portals | null, map: GameMap, ax: number, ay: number, bx: number, by: number): boolean;
  export interface Apparent { x: number; y: number; sees: boolean; through: 0 | 1 | 2 }
  export function apparentPosition(
    map: GameMap, p: Portals | null, from: { x: number; y: number }, to: { x: number; y: number },
    out: Apparent, maxDepth: 1 | 2 = 2
  ): Apparent;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `p === null`: `out` equals `to`, `sees === hasLineOfSight(...)`, `through === 0`.
  - listener 2 tiles in front of A, target 1 tile behind B's plane: `through === 1`, position is `fromDest(to)`
    (≈ 3 tiles straight ahead), `sees === true`.
  - same target but listener on A's back side: no portal image; real position.
  - a target in an unrelated room whose image through some portal lands behind the listener's wall, with the
    segment not passing that portal's opening: not chosen (spec 2.6).
  - depth 2 chain (A → B, B's front faces C): `through === 2`; with `maxDepth: 1`, falls back to the real position.
  - a portal whose centre is 17 tiles away is never tried.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/portals/apparent`. Expected: FAIL.
- [ ] **Step 3: Implement** a recursive search: candidates are the real position and, for each portal whose front
  faces `from` (`dot(from − c, n) < 0`) and centre is within `NEAR_TILES`, the image `fromDest(target-or-deeper)`.
  An image counts when `crossedPortal(from → image)` is that portal, and both legs are portal lines of sight. Prefer
  `sees`, then nearest. Reuse module-level scratch; no allocation per call.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Find where things appear through portals"`

### Task 4: A ray that stops at windows

**Files:**
- Create: `packages/shared/src/portals/ray.ts`; Test: `packages/shared/src/portals/ray.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PortalRayHit extends RayHit { portal: number } // −1: a wall
  export function createPortalRayHit(): PortalRayHit;
  /** castRay from the eye, starting nearDepth along (dx, dy); stops at a plane crossed front→back beyond nearDepth. */
  export function castPortalRay(map: GameMap, p: Portals, ex: number, ey: number, dx: number, dy: number,
    nearDepth: number, out: PortalRayHit): PortalRayHit;
  ```
  Distances are in the same units as `castRay` (perpendicular depth for an unnormalised camera ray). A portal hit
  has `tile 0`, `mapX/mapY` the doorway tile, `side` 1 for 'ns' and 0 for 'we', `wallX` the fraction along the plane.

- [ ] **Step 1: Write the failing tests:**
  - with no doorway on the way, every field equals `castRay`'s.
  - looking at A from its front: `portal === A`, `distance` = depth to the plane.
  - looking at A from its back, and edge-on along its plane line (review focus 3): `portal === −1`, wall as `castRay`.
  - with `nearDepth` past a near wall, the ray ignores that wall and reports depths from the eye, not the start.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/portals/ray`. Expected: FAIL.
- [ ] **Step 3: Implement** the DDA from `raycast.ts` started at `e + nearDepth·d`, adding `nearDepth` to distances;
  in a doorway tile, solve the plane's parameter and stop there if the direction is front→back and it is before the
  tile's exit.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Cast rays that stop at portal windows"`

### Task 5: Protocol and move check

**Files:**
- Modify: `packages/shared/src/protocol/protocol.ts`, `protocol.test.ts`, `packages/shared/src/protocol/movecheck.ts`,
  `movecheck.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PROTOCOL_VERSION = 4;
  export type PortalsMessage = { type: 'portals' };              // client → server, in ClientMessage
  // ServerMessage gains: | { type: 'portals'; on: boolean }, and welcome gains `portals: boolean`
  export function isPlausibleMove(map, from, to, elapsedMs, portals: Portals | null = null): boolean;
  ```

- [ ] **Step 1: Write the failing tests:** `parseClientMessage('{"type":"portals"}')`; server `portals` parses with a
  boolean `on` and rejects a missing one; a welcome without `portals` parses with `portals: false`; a jump of 20 tiles
  explained by one portal is plausible with `portals` and implausible with `null`.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/protocol`. Expected: FAIL.
- [ ] **Step 3: Implement.** The move check measures `from` → `apparentPosition(map, portals, from, to, _, 1)`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Carry the portal mode on the wire"`

### Task 6: The room's flag on the server

**Files:**
- Modify: `apps/server/src/lobby.ts`, `lobby.test.ts`, `apps/server/src/server.ts` (dispatch `portals`),
  `snapshot.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 5.
- Produces: `Lobby.portals(conn: string): void`; private `activePortals(roomId): Portals | null` (wiring built
  lazily per room with `wirePortals(this.opts.map, roomId)` and dropped in `closeRoom`); snapshot rooms gain
  `portals?: boolean`.

- [ ] **Step 1: Write the failing tests:**
  - a person's `portals` broadcasts `{ type: 'portals', on: true }` to everyone, the sender included; a second within
    1000 ms is ignored; after 1000 ms it flips back.
  - a later joiner's welcome has `portals: true`; a bot or an unjoined connection can't flip it.
  - snapshot → restore keeps `portals: true`; a snapshot without the field restores off.
  - `state` with a portal jump is accepted while on; review focus 5: a jump sent 500 ms after an off-flip is accepted,
    and one sent 1500 ms after is corrected; a plain doorway crossing 500 ms after an on-flip is accepted.
- [ ] **Step 2: Run** `pnpm vitest run apps/server`. Expected: FAIL.
- [ ] **Step 3: Implement.** `state` checks with the current mode, then, within 1000 ms of `flippedAt`, the other.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Let anyone in a room flip its portals"`

### Task 7: Bots, ball, vacuum and fan-out through portals

**Files:**
- Modify: `apps/server/src/bots.ts`, `packages/shared/src/objects/ball/ball.ts`,
  `packages/shared/src/objects/vacuum/vacuum.ts`, `apps/server/src/fanout.ts`, `apps/server/src/lobby.ts`, and their
  tests

**Interfaces:**
- Consumes: Tasks 2, 3, 6.
- Produces:
  ```ts
  stepBot(map, bot, dt, rng, portals: Portals | null = null)
  stepBall(map, ball, dt, bodies, portals: Portals | null = null)  // bodies already at their apparent positions
  stepVacuum(nav, v, dt, rng, people, portals: Portals | null = null) // people already apparent
  selectBatch(self, peers, sent, now, portals: Portals | null = null)  // near = apparent distance ≤ NEAR_TILES
  ```

- [ ] **Step 1: Write the failing tests:**
  - a ball rolling front→back through A comes out of B with its velocity rotated.
  - a vacuum driving through A comes out of B, clears its waypoints and plans a new leg on its next step.
  - `selectBatch`: a peer 30 tiles away on the map but 3 tiles away through a portal is near.
  - lobby: with portals on, a person standing 0.3 tiles past B's plane, seen from a ball just behind A's front, pushes
    the ball (contacts via `apparentPosition(…, 1)` from the ball); a kick from beyond A reaches a ball past B.
  - every existing sim test passes unchanged with `null`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server packages/shared/src/objects`. Expected: FAIL.
- [ ] **Step 3: Implement.** The sims call `carryThroughPortal` after each move; the lobby maps bodies, people and the
  kicker to apparent positions from the ball or vacuum before calling them.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Send bots, the ball and the vacuum through portals"`

### Task 8: Y, the session and the notice

**Files:**
- Modify: `apps/web/src/input/room-keys.ts` (+test), `apps/web/src/net/session.ts` (+test),
  `apps/web/src/game/room-controls.ts`, `apps/web/src/game/room.ts`, `apps/web/src/telemetry/analytics.ts`,
  `apps/web/public/privacy.html` if it lists events
- Create: `apps/web/src/ui/portal-notice.ts` (+test)

**Interfaces:**
- Produces: `RoomKey` gains `{ kind: 'portals' }` (KeyY, in the room, not repeat, no modifier);
  `Session.portals: boolean`, `Session.sendPortals(): void`, `SessionListener.portalsChanged?(on: boolean)`;
  `showPortalNotice(ui: HTMLElement, on: boolean): void` (replaces any notice showing, gone after 2000 ms);
  `AnalyticsEvent` gains `{ name: 'portals_toggled'; on: boolean }`.

- [ ] **Step 1: Write the failing tests:** Y maps to `portals` only in the room and not with a modifier or repeat;
  the session sends `{ type: 'portals' }`, takes `portals` from welcome and from `portals` messages and calls
  `portalsChanged`; the notice shows `Portals on` and is gone after 2000 ms (fake timers).
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/input apps/web/src/net apps/web/src/ui/portal-notice`. Expected: FAIL.
- [ ] **Step 3: Implement**, and update the header comment of `room-keys.ts` to list Y.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Flip the room's portals with Y"`

### Task 9: Local movement, prediction and interpolation

**Files:**
- Modify: `apps/web/src/game/local-player.ts`, `apps/web/src/game/ball-prediction.ts`,
  `packages/shared/src/net/interpolation.ts`, `apps/web/src/game/remote-world.ts`, and their tests

**Interfaces:**
- Consumes: Tasks 2, 7, 8.
- Produces: `Snapshot.jump?: true`; `SnapshotBuffer.sample` returns the earlier pose for `t` before a jump's `t`, never
  a blend; remote-world marks a peer pose a jump when `isPlausibleMove(map, last, next, dt)` (no portals) fails, and
  an object pose when it moved more than `JUMP_TILES = 2` since the last; local player and ball prediction step with
  the session's active `Portals | null`.

- [ ] **Step 1: Write the failing tests:** a buffer `a(t0) → b(t1, jump)` sampled at the midpoint gives `a`;
  without `jump`, the blend; remote-world marks a 20-tile hop in 66 ms as a jump and a 0.2-tile step not (review
  focus 5); the predicted ball goes through a portal like the server's.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/net apps/web/src/game`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Walk, predict and interpolate through portals"`

### Task 10: Sound, faces and labels from apparent positions

**Files:**
- Create: `apps/web/src/game/apparent-world.ts` (+test)
- Modify: `apps/web/src/game/room-loop.ts`, `apps/web/src/audio/engine.ts`, `apps/web/src/media/interest.ts`,
  `apps/web/src/renderer/labels.ts` call site, and tests

**Interfaces:**
- Produces:
  ```ts
  export interface ApparentWorld { update(map: GameMap, portals: Portals | null, eye: { x: number; y: number },
    things: Iterable<{ id: string; x: number; y: number }>): ReadonlyMap<string, Apparent> } // reuses its Apparents
  export function createApparentWorld(): ApparentWorld;
  ```
  Audio sources and interest peers take `{ x, y, sees }`; the engine and interest use `sees` instead of their own
  `hasLineOfSight` call. Labels are drawn at the apparent position. The automap keeps real positions.

- [ ] **Step 1: Write the failing tests:** with `null`, every Apparent equals the real position and the engine's gains
  equal today's; a peer through a portal gets near gains, pan toward the doorway, and a 64 or 128 face want.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/game apps/web/src/audio apps/web/src/media`. Expected: FAIL.
- [ ] **Step 3: Implement.** One `update` per frame in the room loop; the 250 ms interest tick reads the latest map.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Hear and subscribe to people through portals"`

### Task 11: Drawing through windows

**Files:**
- Modify: `apps/web/src/renderer/framebuffer.ts`, `walls.ts`, `sprites.ts`, `voxels.ts`, `mirror.ts`,
  `object-shadows.ts`, `frame.ts`, and tests (`walls.test.ts`, `sprites.test.ts`, new `frame.test.ts` cases)

**Interfaces:**
- Consumes: Tasks 1, 4.
- Produces:
  ```ts
  // Framebuffer gains: portalAt: Int32Array (per column, −1 or the portal a window shows)
  export interface Pass { fromCol: number; toCol: number; nearDepth: Float64Array | null; lastLevel: boolean }
  // Room (walls.ts) gains: portals: Portals | null; pass: Pass. renderSprites takes the same Pass.
  ```
  `renderView` (frame.ts) draws the main pass, groups `portalAt` into runs, and per run renders the scene from
  `toDest(eye)` (angle via `applyAngle`) into the scratch framebuffer for the next level (two, created with the frame
  and refitted with it), for those columns, with `nearDepth` = the plane depths, then copies each column's rows
  `[wallStart, wallEnd)` of the plane back. At `lastLevel`, a window is filled black instead.

- [ ] **Step 1: Write the failing tests:**
  - with `portals: null`, the frame's pixels equal today's (render a fixed scene, compare to a hash taken before the
    change).
  - looking at A from its front, the window columns show B's back side: the pixel at the window's centre equals the
    pixel of a frame rendered from `toDest(eye)` with `nearDepth` at the plane.
  - a sprite standing between the virtual eye and B's plane is not drawn in the window; one just past B's plane is.
  - review focus 4: two portals in a chain three deep: the third window is black (`0xff000000`) in two consecutive
    frames with different eyes.
  - `seen` facts count a person drawn only through a window.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/renderer`. Expected: FAIL.
- [ ] **Step 3: Implement.** `castColumnRay` uses `castPortalRay` when `portals`, recording `portalAt` and treating
  the plane like a wall for `zbuffer`, `wallStart` and `wallEnd`, while drawing nothing in those rows. Every pass loops
  over `[fromCol, toCol)` only; sprites and voxels skip columns where their depth ≤ `nearDepth[col]`. The frame's floor
  tables (shadows, glow) are built once per frame without view culling when portals are on, and reused by every pass.
  The floor mirror works on the pass's column range.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Draw the room through portal windows"`

### Task 12: Benchmarks, e2e, docs and the load test

**Files:**
- Modify: `apps/web/bench/walls.ts`, `apps/web/bench/sprites.ts` (a portals-on case), `docs/open-decisions.md`
  (D27, Resolved), `AGENTS.md` (one gotcha: `portals: null` is today's behaviour; the wiring is local, from the room
  id; windows are drawn by re-running passes, so new passes must honour `Pass`)
- Create: `apps/web/e2e/portals.spec.ts`

- [ ] **Step 1: Write** the e2e spec: two tabs in a room; tab A presses Y; tab B shows `Portals on` and
  `window.__game` reports portals on; A presses Y again after 1 s and both show `Portals off`.
- [ ] **Step 2: Run** `pnpm e2e -- portals`. Expected: PASS.
- [ ] **Step 3: Run** `pnpm bench:walls` and `pnpm bench:sprites` on main and on this branch. Expected: identical
  pixel hashes with portals off; frame time with off within noise of main; portals-on numbers recorded in D27.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm test`. Expected: all pass.
- [ ] **Step 5: Manual:** `pnpm dev`, open `/?bots=100`, start a party, press Y. Check that walking through doorways
  front→back jumps, the view through a doorway matches where it leads, and the server's tick time (`/metrics`) stays
  inside 66 ms. Record the numbers in D27.
- [ ] **Step 6: Commit** `git commit -m "Record portals: benchmarks, e2e and D27"`
