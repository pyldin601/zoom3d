# Scooter Headlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ridden scooter throws a cone of light ahead along its heading, shadowed by walls like the lighter. Its stem
lamp glows only while ridden.

**Architecture:**
- Restore the `Glow` cone that commit `907b48f` removed. Every lighting pass already goes through `glowLight` and
  `glowReaching`, so they pick it up.
- A new `renderer/headlight.ts` pools one cone glow and one shadow table per rider, as `renderer/lighter.ts` does.
- `remote-world.ts` (others) and `local-player.ts` (own) emit headlight sources. `frame.ts` adds their glows to the
  lit-room object glows, beside the lighters.
- The scooter model splits into a parked one (lamp dark) and a ridden one (lamp glowing).

**Tech Stack:** TypeScript, vitest, Biome, the Canvas2D ray-casting renderer, `apps/web/bench/walls.ts`.

**Spec:** `docs/superpowers/specs/2026-11-07-scooter-headlight-design.md`

## Global Constraints

- **Cone:** 35° each way, the last 10° fading out (the removed lighter cone's values).
- **Light:** reach 5 tiles, strength 1.5 (a full lamp is 1), no flicker. Colour is linear `{ r: 1, g: 0.9, b: 0.7 }`, a
  warm white near the lamp voxel's `0xfff2c8`. These are starting values.
- **Direction:** the beam follows the scooter's heading: `pose.angle` for the local player, never `eye()`, and the
  drawn heading for others.
- **Where it shows:** only in a lit room, like the lighters. Nothing through portals, no reflections, and no shadows
  cast by people or objects.
- **Shadows:** a `GlowShadow` per rider, refilled with `fillGlowSeen` only when the lamp enters another `FLOOR_SUB`
  floor cell or the portals switch, never on a turn.
- **Unchanged pixels:** scenes with no rider draw exactly as before. Every existing `bench:walls` and `bench:sprites`
  hash stays the same.
- **Code style:** no allocations per frame or per column (AGENTS.md). Use `.at()` over `[i] as T`. Braced bodies,
  Biome style.

## Review Focus

1. **Head look while riding.** Turning the head (`localPlayer.head`) must not swing the beam. Task 3 tests that the
   own source's angle is `pose.angle` with `head` set to 1.
2. **Stepping off or dropping out.** The light must vanish the frame the rider steps off, and a forgotten rider's table
   must not leak. Task 2 tests that a source missing from an update is dropped. Task 3 tests that the own source is
   null on foot.
3. **Unlit and flat rooms.** These must get no headlight glows and no refill cost. Task 3 tests that `gatherGlows`
   with no `scene.lighting` yields no headlight glow.
4. **Portals switching on and off mid-ride.** This must refill the table so the light stops at doorways. Task 2 tests
   a refill when `portals` changes with the lamp in the same cell.
5. **A rider with no drawn position this frame** (not yet interpolated, or gone) must emit no headlight. Task 3 tests
   this in `remote-world`.

---

### Task 1: Restore the glow cone

**Files:**
- Modify: `apps/web/src/renderer/glow.ts` (`Glow`, new `GlowCone`, `coneFactor`, `glowLight`, `glowReaching`, the
  avatar and portal glow literals)
- Modify: every other `Glow` literal (`cone: null`): `renderer/lighter.ts`, `apps/web/bench/walls.ts`,
  `apps/web/bench/sprites.ts`, and the tests that build glows (`glow.test.ts`, `walls.test.ts`, `voxels.test.ts`,
  `frame.test.ts`, `lighter.test.ts`). Find them with `pnpm typecheck`.
- Test: `apps/web/src/renderer/glow.test.ts`

**Interfaces:**
- Produces:
  - `interface GlowCone { dx: number; dy: number; cosEdge: number; cosFull: number }`
  - `Glow.cone: GlowCone | null`
  - `export function coneFactor(g: Glow, x: number, y: number): number`

- [ ] **Step 1: Write the failing tests.** Restore the `describe('a glow with its own reach and a cone')` block that
  `git show 907b48f -- apps/web/src/renderer/glow.test.ts` removed, with its three tests:
  - "the cone is full near its axis, fades at its edge and is dark outside and behind": 1 at 0° and 20°, between 0
    and 1 at 30°, 0 at 40° and behind;
  - "without a cone, or right under the glow, the factor is 1";
  - "the cone lights the floor ahead and leaves the floor behind dark".

  Also add one for objects: `glowReaching(cone glow, 2, 0, 0) > 0` and `glowReaching(cone glow, -2, 0, 0) === 0`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/src/renderer/glow.test.ts`. Expected: FAIL, because
  `coneFactor` isn't exported.
- [ ] **Step 3: Restore the code.** Restore `GlowCone`, `Glow.cone`, `coneFactor` (smoothstep between `cosEdge` and
  `cosFull`, 1 at distance 0) and its early-out use in `glowLight` and `glowReaching` exactly as before `907b48f`. Add
  `cone: null` to every other literal.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test`. Expected: all pass.
- [ ] **Step 5: Prove the pixels are unchanged.** Run `pnpm bench:walls` and `pnpm bench:sprites` on `main` (before)
  and on the branch, saving each output to the workspace. Expected: every hash line is identical.
- [ ] **Step 6: Commit** "Bring back the glow cone, for the scooter's headlight".

### Task 2: Headlight glows

**Files:**
- Create: `apps/web/src/renderer/headlight.ts`
- Test: `apps/web/src/renderer/headlight.test.ts`

**Interfaces:**
- Consumes: `GlowCone` and `Glow.cone` (Task 1); `newGlowShadow`, `fillGlowSeen` and `FLOOR_SUB` from
  `renderer/lighting.ts`.
- Produces:
  - `interface HeadlightSource { readonly key: string; readonly x: number; readonly y: number; readonly angle: number }`
    holds the rider's position and the scooter's heading.
  - `HEADLIGHT_REACH = 5`, `HEADLIGHT_STRENGTH = 1.5`, `HEADLIGHT_COLOUR`, `HEADLIGHT_CONE_HALF_RAD`,
    `HEADLIGHT_CONE_FADE_RAD` and `HEADLIGHT_AHEAD_TILES = 0.3`. The last is how far ahead of the rider the lamp
    sits; it is the builder's call, at about the stem.
  - `interface HeadlightGlows { update(sources: Iterable<HeadlightSource>, map: GameMap, portals: Portals | null): readonly Glow[] }`
  - `function createHeadlightGlows(): HeadlightGlows`

- [ ] **Step 1: Write the failing tests** in `headlight.test.ts`, on a small open map with one wall:
  - "the glow sits ahead of the rider along the heading, its cone pointing the same way": for angle π/2, glow (x, y)
    is the rider + (0, 0.3), and `cone.dx ≈ 0`, `cone.dy ≈ 1`.
  - "it lights the floor ahead and none behind": `glowLight(glow, x, y + 2, 0, 0, 0, 1) > 0`, and the point 2 tiles
    behind gets 0.
  - "a wall blocks it": a floor point just past the wall, inside the cone, gets 0.
  - "turning keeps the table, moving to another floor cell refills it": spy on the shadow's `seen` contents, or compare
    the table's `firstCol` and `firstRow` and a sample cell after a pure turn and after a move of 1/`FLOOR_SUB`.
  - "switching portals refills the table in the same cell" (Review Focus 4).
  - "a rider missing from an update is dropped, and a new key gets a fresh glow" (Review Focus 2). The second update
    without the key returns no glow. On return, the glow is a different object.
  - "the same glow objects are reused from frame to frame": two updates with the same key return the identical `Glow`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/src/renderer/headlight.test.ts`. Expected: FAIL, because the
  module doesn't exist.
- [ ] **Step 3: Implement `createHeadlightGlows()`.** It follows `createLighterGlows`' pooling and stamp-forgetting,
  but has no flicker. It places the lamp at `x + cos(angle) × AHEAD` and `y + sin(angle) × AHEAD`, sets the cone from
  the angle every update, and keys the cell check on the lamp's position.
  - Ruling to record: it is a separate module rather than a shared one with the lighter. The two differ in flicker,
    cone and offset, and merging them would touch the lighter's hashes.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the headlight glows: a cone ahead of each rider, shadowed by walls".

### Task 3: Riders emit headlights, and the frame draws them

**Files:**
- Modify: `apps/web/src/game/remote-world.ts`: a `headlights: readonly HeadlightSource[]` list beside `lighters`,
  filled in `collect` for each peer with `riding !== null` and a drawn position, angle from `headings`, key = peer id.
  Use reused objects, as for `lighters`.
- Modify: `apps/web/src/game/local-player.ts`: `headlight(): HeadlightSource | null`, the rider's `pose.x`, `pose.y`
  and `pose.angle` while riding, else null. One reused object.
- Modify: `apps/web/src/renderer/frame.ts`:
  - add `RoomScene.headlights` and `RoomScene.ownHeadlight`;
  - `gatherGlows` appends `headlightGlows.update(...)` after the lighters into `objectGlows`, only when
    `scene.lighting`;
  - the source list is reused, as `listLighters` is.
- Modify: `apps/web/src/game/room-loop.ts`:
  - `headlights: world.headlights`;
  - `scene.ownHeadlight = isConnected(room) ? localPlayer.headlight() : null`.
- Tests: `remote-world.test.ts`, `local-player.test.ts`, `frame.test.ts`

**Interfaces:**
- Consumes: `HeadlightSource` and `createHeadlightGlows` (Task 2).
- Produces:
  - `RemoteWorld.headlights`
  - `LocalPlayer.headlight()`
  - `RoomScene.headlights: readonly HeadlightSource[]`
  - `RoomScene.ownHeadlight: HeadlightSource | null`

- [ ] **Step 1: Write the failing tests:**
  - local-player: "riding, the headlight follows the heading, not the head". Set riding, `pose.angle = 0.5` and
    `head = 1`, and expect `headlight()` to have angle 0.5 (Review Focus 1). Also "on foot there is no headlight"
    (Review Focus 2).
  - remote-world: "a rider gets a headlight at their drawn position and heading; a walker and a rider not yet drawn get
    none" (Review Focus 5).
  - frame: "a lit room's object glows include the riders' headlights" and "an unlit room gets none" (Review Focus 3),
    in the same style as the existing lighter tests in `frame.test.ts`.
- [ ] **Step 2: Run** these three test files. Expected: FAIL, because the members don't exist.
- [ ] **Step 3: Implement** the members and the wiring listed under Files.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** "Light the way ahead of every rider".

### Task 4: The lamp glows only while ridden

**Files:**
- Modify: `apps/web/src/renderer/models/scooter.ts`:
  - `SCOOTER_MODEL` (parked) lamp is a plain `rgb(0xd8, 0xd4, 0xc4)`, not `glowing`;
  - a new `RIDDEN_SCOOTER_MODEL` with the glowing lamp of today;
  - both are built from one shape function taking the lamp colour.
- Modify: `apps/web/src/game/remote-world.ts`, where riders are placed with `RIDDEN_SCOOTER_MODEL`, and
  `apps/web/src/game/local-player.ts`, where `ownScooter.model` is `RIDDEN_SCOOTER_MODEL`.
- Test: `apps/web/src/renderer/models/scooter.test.ts`. Create it if there is none, following other model tests.

**Interfaces:**
- Produces: `export const RIDDEN_SCOOTER_MODEL: VoxelModel`

- [ ] **Step 1: Write the failing test** "the lamp glows on a ridden scooter and is dark on a parked one". Read the
  lamp voxel (x = 11, y = 1, z = 7) from each model. Use whatever accessor the voxel model exposes, the same way other
  model tests read voxels. Expect it glowing in `RIDDEN_SCOOTER_MODEL` and not glowing in `SCOOTER_MODEL`. Add a
  remote-world assertion that a rider is placed with `RIDDEN_SCOOTER_MODEL`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** the change described under Files.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test`. Expected: all pass.
- [ ] **Step 5: Run** `pnpm bench:sprites`. Expected: hashes unchanged. Its scenes have no scooters; if one does, its
  changed hash is expected and gets noted in the commit.
- [ ] **Step 6: Commit** "Light the stem lamp only while ridden".

### Task 5: Measure, document, look

**Files:**
- Modify: `apps/web/bench/walls.ts`:
  - a riding case kept out of `MODES`, as the lighter's is, so existing hashes stay;
  - it reports the headlight shadow refill ms (median over lamp poses) and the frame ms with 4 riders' headlights,
    tables already filled.
- Modify: `docs/open-decisions.md`: a D36 amendment, "A headlight that lights the way". It records the values, the cone
  restored from D31, shadows like the lighter, the lamp dark when parked, and what's left out.
- Modify: `AGENTS.md`: in the kick scooters gotcha, one clause that the headlight is a cone glow pointed by
  `pose.angle`, never `eye()`. In the lighter gotcha, one clause that glows may again carry a `cone`.
- Modify: the spec's status line, to "approved and built".

- [ ] **Step 1: Add the bench case. Run** `pnpm bench:walls`. Expected: existing hashes unchanged. Record the refill
  and the frame ms in the D36 amendment. If the refill is over 0.5 ms, switch the refill to per tile, record the
  ruling, and rerun.
- [ ] **Step 2: Write the docs** described under Files.
- [ ] **Step 3: Look in the game.**
  - Start the `zoom3d` preview and join a room with lighting on.
  - Walk to a scooter, press E, and take a screenshot: a cone of warm light on the floor ahead.
  - Turn the head with the mouse: the beam stays.
  - Step off: the light goes out and the lamp voxel is dark.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e scooter`. Expected: all pass.
- [ ] **Step 5: Commit** "Measure and document the scooter headlight".
