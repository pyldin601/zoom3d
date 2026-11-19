# Realistic Portals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-person *Portals: Classic / Realistic* choice in the backtick console. Realistic draws, lights and
places sound through doorways the way photons would go: the way walkers go.

**Architecture:** Realistic means today's portal machinery run on a second `Portals` value, the photon set: every normal
reversed and every destination replaced by its source. One room-level `sightPortals()` picks the set for everything to
do with seeing and hearing. Everything that moves keeps the classic set. Server and client count a pair as near when it
is near under either set, so nothing goes on the wire.

**Tech Stack:** TypeScript, Vitest, pnpm workspace (`packages/shared`, `apps/web`, `apps/server`), Biome.

**Spec:** `docs/superpowers/specs/2026-11-19-realistic-portals-design.md`

## Global Constraints

- With portals off, or with classic chosen, nothing changes, pixel for pixel and sound for sound. The existing
  `pnpm bench:walls` and `pnpm bench:sprites` hashes must stay identical.
- No protocol change: `PROTOCOL_VERSION` stays; the look is never sent.
- Moving things always use the classic set: `LocalPlayer.walk`, `stepPlayer`, `stepRide`, `crossedPortal`, the ball's
  physics, mind, kicks and `holdSpot`, on server and client alike.
- The look switches whole. Sight, lamp table and glow shadows come from the same set in every frame, and realistic is
  shown only once its table is baked.
- The new setting goes in `RenderSettings` under the existing key `zoom3d.render.v1`, default `'classic'`, normalised
  on its own.
- Server tick budget: at 100 people with portals on, `fanOut`'s mean must stay ≤ 12 ms (`pnpm bench:tick`). Over that,
  cut the cost before merging.
- Code style: Biome (`pnpm exec biome check --write .`), braced bodies, `.at()` over `[i] as T`, no "you/your" in
  identifiers, comments only say why. No allocation in per-frame paths: the photon set is built once per classic set
  and memoised.

## Review Focus

1. **Switching while the room is dark (portal sequence blackout).** Realistic in the dark must use the photon set's
   blackout table, whose `portalGlowSeen` belongs to the photon glows. Pinned in Task 3.
2. **Unlit room (`?lights=off`).** Realistic must be shown at once, with nothing to bake and no lighting. Pinned in
   Task 3 (`realisticReady()` true when unlit).
3. **Realistic chosen before its table is baked.** The room keeps classic sight *and* classic light until the bake
   lands. Pinned in Task 5 (`shownPortals`).
4. **Old or bad saved settings** (`{ mode: 'shadows' }`, `{ portals: 'weird' }`): `portals` falls back to classic
   alone, and `mode` survives. Pinned in Task 4.
5. **Identity of the photon set.** The lighter and headlight shadow caches refill whenever `portals !== entry.portals`,
   so a fresh photon set every frame would refill every frame. `photonPortals(x)` must return the same object each
   time. Pinned in Task 1.

---

### Task 1: The photon set

**Files:**
- Modify: `packages/shared/src/portals/wiring.ts`
- Test: `packages/shared/src/portals/wiring.test.ts`, `packages/shared/src/portals/ray.test.ts`

**Interfaces:**
- Produces: `photonPortals(classic: Portals): Portals`, exported from `@zoom3d/shared`. It shares `map` and `byTile`
  with `classic`. Each portal has `nx, ny` negated, `to` set to its classic source (the `j` with
  `classic.list[j].to === i`), `toDest = transformBetween(flipped i, flipped to)` and `fromDest = invert(toDest)`. It
  is memoised in a module `WeakMap<Portals, Portals>`, so the same input gives the same object.

- [ ] **Step 1: Write the failing tests** in `wiring.test.ts`, `describe('photonPortals', …)`, on
  `wirePortals(map, 'abc')`:
  - `'reverses every normal and sends each doorway to its classic source'`: for every `i`,
    `photon.list[i].nx === -classic.list[i].nx` (likewise `ny`), and `classic.list.at(photon.list.at(i).to).to === i`.
  - `'maps centre to destination centre and normal to destination normal'`: the same assertions as the existing
    `wirePortals` test of that name, run on the photon set.
  - `'keeps fromDest the inverse of toDest'`: the existing test's assertions, on the photon set.
  - `'is the same object every time, sharing map and byTile'`:
    `expect(photonPortals(c)).toBe(photonPortals(c)); expect(photonPortals(c).byTile).toBe(c.byTile)`.
  - `'turned round twice gives the classic wiring back'`: `photonPortals(photonPortals(c)).list` `toEqual` `c.list`.

  In `ray.test.ts`, using the file's `PORTALS` hall (A front north at x = 2):
  - `'with the photon set, a doorway seen from its classic back stops the ray'`:
    `castPortalRay(MAP, photonPortals(PORTALS), 2.5, 5.5, 0, -1, 0, hit)` gives `hit.portal === A` and
    `distance ≈ 2`. The same cast on `PORTALS` gives `portal === -1` (it walks on into the north room).
  - `'with the photon set, a doorway seen from its classic front is ordinary'`: from `(2.5, 1.5)` heading `(0, 1)`,
    `portal === -1`.

- [ ] **Step 2: Run** `pnpm --filter @zoom3d/shared exec vitest run src/portals` and expect FAIL
  (`photonPortals` is not exported).
- [ ] **Step 3: Implement `photonPortals`** in `wiring.ts` next to `wirePortals`, reusing `transformBetween`,
  `invert` and `IDENTITY` for an empty list. Add a one-line doc: the view realistic portals give, light going the way
  walkers go (spec §3).
- [ ] **Step 4: Run** the same command and expect PASS. Then run `pnpm typecheck`.
- [ ] **Step 5: Commit** `Add the photon portal set: fronts swapped, loop reversed`.

### Task 2: Near under either rule

**Files:**
- Modify: `packages/shared/src/portals/apparent.ts`, `apps/server/src/fanout.ts:38`,
  `apps/web/src/net/peer-delay.ts:27-31`
- Test: `packages/shared/src/portals/apparent.test.ts`, `apps/server/src/fanout.test.ts`

**Interfaces:**
- Consumes: `photonPortals` (Task 1).
- Produces: `isNearEitherWay(p: Portals | null, from: Point, to: Point, rangeTiles = NEAR_TILES): boolean`. It returns
  `isNear(p, …) || (p !== null && isNear(photonPortals(p), …))`. `selectBatch` and `nearTier` call it in place of
  `isNear`. Their own signatures don't change: they still take the classic set.

- [ ] **Step 1: Write the failing tests.**
  - `apparent.test.ts`, `'isNearEitherWay counts a pair near through either set'`: on LEVEL1 with
    `wirePortals(map, 'abc')`, scan a grid of open tile centres (step 2) for pairs where
    `!isNear(c, a, b) && isNear(photonPortals(c), a, b)`. Assert at least one is found, and that
    `isNearEitherWay(c, a, b)` is true for each. Also assert `isNearEitherWay(null, a, b) === isNear(null, a, b)` for
    the first 50 pairs scanned.
  - `fanout.test.ts`, `'sends a peer near only through the photon set every tick'`: take one such pair. Call
    `selectBatch` twice 66 ms apart with a changed pose. The second batch holds the peer, where `FAR_INTERVAL_MS`
    would have held it back.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/shared exec vitest run src/portals/apparent.test.ts` and
  `pnpm --filter @zoom3d/server exec vitest run src/fanout.test.ts`, and expect FAIL.
- [ ] **Step 3: Implement** `isNearEitherWay` in `apparent.ts`. Swap it in at `fanout.ts:38` and in `nearTier`, and
  update both doc comments (D38: near through either look, so server and client agree whatever each viewer chose).
- [ ] **Step 4: Run** both test commands and `pnpm test`, and expect PASS.
- [ ] **Step 5: Measure** with `pnpm bench:tick`, run twice, and note the portals-on `fanOut` mean and p99 for 4 and
  100 people (expect about 0.3 ms and about 8.4 ms). If the 100-people mean is over 12 ms, stop and report before
  going on.
- [ ] **Step 6: Commit** `Count a pair near through either portal look`.

### Task 3: The photon lamp table

**Files:**
- Modify: `apps/web/src/renderer/room-lighting.ts`, `apps/web/src/game/room.ts:137` (the one caller of
  `RoomLighting.lighting`)
- Test: `apps/web/src/renderer/room-lighting.test.ts`

**Interfaces:**
- Consumes: `photonPortals`.
- Produces: a new `RoomLighting`:
  - `readonly portals: Portals`: the classic wiring, as now.
  - `readonly photon: Portals`, which is `photonPortals(portals)`.
  - `bakeRealistic(): void`: bakes `bakePortalLighting(plain, photon, FLOOR, CEILING)` and its `blackedOut` once.
    Repeat calls do nothing.
  - `realisticReady(): boolean`: true once baked, or at once when `plain` is null (unlit).
  - `lighting(sight: Portals | null, dark: boolean): Lighting | null`. `sight` is the set in view (null when portals
    are off). It returns `plain` for null, the classic table for `portals` and the photon table for `photon`. Dark
    returns the blackout of the photon table when `sight === photon`, otherwise the classic one (as today for null).
    Asking for `photon` before the bake throws (a bug, never a fallback).
  - In `room.ts`, `lighting(dark)` passes the set the room shows. Until Task 5 that is `portals()`, so behaviour is
    unchanged.

- [ ] **Step 1: Rewrite the existing tests** for the new signature (`lighting(portals, …)` for true, `lighting(null, …)`
  for false) and add:
  - `'the photon table is baked only on bakeRealistic, once'`: `bakePortalLighting` is called once at creation.
    `realisticReady()` is false. After two `bakeRealistic()` calls it has been called twice in total, and
    `realisticReady()` is true.
  - `'lighting(photon) is the photon set's table'`: after baking, `lighting(room.photon, false)?.portals` is
    `room.photon`, and it is not the classic table.
  - `'in the dark, realistic keeps the photon glows' shadows'`: `lighting(room.photon, true)` has no lamps, and its
    `portalGlowSeen` is `lighting(room.photon, false)?.portalGlowSeen`.
  - `'an unlit room is ready for realistic at once and has no lighting'`: `createRoomLighting(null, portals)` gives
    `realisticReady()` true and `lighting(room.photon, d)` null for both `d`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/room-lighting.test.ts` and expect FAIL.
- [ ] **Step 3: Implement** the new `RoomLighting` in `room-lighting.ts`, and update the file's header comment
  (realistic's table is baked on demand, about 290 ms). Adapt the `room.ts` call.
- [ ] **Step 4: Run** the test file, then `pnpm typecheck` and `pnpm test`, and expect PASS.
- [ ] **Step 5: Commit** `Bake a lamp table for realistic portals on demand`.

### Task 4: The console choice

**Files:**
- Modify: `apps/web/src/ui/render-settings.ts`, `apps/web/src/ui/console-panel.ts` (add a row after
  `lightingRow`), `apps/web/src/game/game.ts`
- Test: `apps/web/src/ui/render-settings.test.ts`, `apps/web/src/ui/console-panel.test.ts`

**Interfaces:**
- Produces:
  - `type PortalLook = 'classic' | 'realistic'`, `PORTAL_LOOKS: readonly PortalLook[] = ['classic', 'realistic']` and
    `PORTAL_LOOK_NAMES: Record<PortalLook, string> = { classic: 'Classic', realistic: 'Realistic' }`.
  - `RenderSettings` gains `portals: PortalLook`, and `DEFAULT_RENDER_SETTINGS` becomes
    `{ mode: 'reflections', portals: 'classic' }`.
  - `game.ts`'s `setRenderMode` stays for the touch tray. A new `setRenderSettings(s: RenderSettings)` is the
    console's path. It saves, then, when `s.portals === 'realistic'` and a lobby or room is open, calls
    `whenIdle(() => roomLightingFor(currentRoomId).bakeRealistic())`. `currentRoomId: string | null` is a new `let`
    in `createGame`, set in `showLobbyFor`. `roomLightingByRoom` keeps the latest room's instance, so this reaches the
    same `RoomLighting` the room uses.
  - `showLobbyFor` adds a second `whenIdle` that calls `roomLightingFor(roomId).bakeRealistic()` when the saved look
    is realistic.

- [ ] **Step 1: Write the failing tests.**
  - `render-settings.test.ts`: `normalizeRenderSettings({ mode: 'shadows' })` gives
    `{ mode: 'shadows', portals: 'classic' }`. `normalizeRenderSettings({ mode: 'flat', portals: 'realistic' })` keeps
    both. `normalizeRenderSettings({ portals: 'weird' })` gives `portals: 'classic'`.
  - `console-panel.test.ts`, `'the Portals row switches the look and keeps the lighting mode'`: open the panel with
    `{ mode: 'shadows', portals: 'classic' }` and change the `Portals` select to `realistic`. `onChange` is called with
    `{ mode: 'shadows', portals: 'realistic' }`. The select's options read `Classic` and `Realistic`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/ui/render-settings.test.ts
  src/ui/console-panel.test.ts` and expect FAIL.
- [ ] **Step 3: Implement** the type, the constants and the normalisation. Add `portalRow`, labelled `Portals`, built
  like `lightingRow`. Wire `onChange` in `game.ts` to `setRenderSettings(s)` followed by `controls.refresh()`.
- [ ] **Step 4: Run** the tests, `pnpm typecheck` and `pnpm test`, and expect PASS.
- [ ] **Step 5: Commit** `Add the Portals look to the console's renderer settings`.

### Task 5: Sight through the chosen set

**Files:**
- Create: `apps/web/src/game/portal-look.ts` (pure)
- Modify: `apps/web/src/game/room.ts`, `apps/web/src/game/room-loop.ts`, `apps/web/src/game/game.ts` (`enterRoom`)
- Test: `apps/web/src/game/portal-look.test.ts`

**Interfaces:**
- Consumes: `RoomLighting.photon`, `realisticReady()` and `lighting(sight, dark)` (Task 3), plus `PortalLook` and
  `renderSettings.portals` (Task 4).
- Produces:
  - `JoinOptions.portalLook: () => PortalLook`, passed by `enterRoom` as `() => renderSettings.portals`.
  - `shownPortals(classic: Portals | null, photon: Portals, look: PortalLook, realisticReady: boolean): Portals | null`
    in `portal-look.ts`. It returns null when `classic` is null, `photon` when `look === 'realistic' &&
    realisticReady`, and otherwise `classic`.
  - `Room.sightPortals(): Portals | null` is `shownPortals(portals(), roomLighting.photon, opts.portalLook(),
    roomLighting.realisticReady())`. `Room.lighting(dark)` becomes `roomLighting.lighting(sightPortals(), dark)`.
    `Room.portals()` stays the classic set, and its doc says it is for what moves.
  - `room-loop.ts` uses `room.sightPortals()` for `hums.sourcesOf`, `apparentWorld.update`, `scene.portals` and both
    `hums.sync` calls. It keeps `room.portals()` for `localPlayer.walk` and `world.sample`. Ball prediction and
    `session` keep `portals()`.

- [ ] **Step 1: Write the failing test** `portal-look.test.ts`, with four cases from `portalHall()` and its photon set:
  - Off: `shownPortals(null, photon, 'realistic', true)` is null.
  - Classic chosen: it returns `classic`.
  - Realistic, not ready: it returns `classic`.
  - Realistic, ready: it returns `photon`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/game/portal-look.test.ts` and expect FAIL.
- [ ] **Step 3: Implement** `shownPortals`, `JoinOptions.portalLook`, `Room.sightPortals` and the `room-loop.ts` call
  sites listed above. Then
  grep `room.portals()` and `room?.portals()` in `apps/web/src` and confirm every remaining use is about movement or
  nearness.
- [ ] **Step 4: Run** `pnpm typecheck`, `pnpm lint` and `pnpm test`, and expect PASS.
- [ ] **Step 5: Run** `pnpm e2e -g portals` and expect PASS (classic is the default, so it is unchanged).
- [ ] **Step 6: Commit** `Draw, light and hear portals through the chosen look`.

### Task 6: Proofs, numbers and the decision

**Files:**
- Modify: `apps/web/bench/walls.ts`, `docs/open-decisions.md` (add D38 under Resolved), `AGENTS.md` (Portals
  gotcha), `docs/superpowers/specs/2026-11-19-realistic-portals-design.md` (status line)

- [ ] **Step 1: Confirm classic is untouched.** Run `pnpm bench:walls` and `pnpm bench:sprites` on this branch and on
  `origin/main`. Every existing hash must be identical.
- [ ] **Step 2: Add realistic doorway frames** to `bench:walls`: the same 8 doorway poses turned round to face each
  doorway from its classic back (1.5 tiles behind, looking in). Time them with `photonPortals(portals)` and its
  freshly baked table, and print a pixel hash. Also print the photon table's bake time. Run it twice.
- [ ] **Step 3: Check by eye in the game.** Run `pnpm dev`, open a room, press Y, switch the console to Realistic, and
  walk up to a doorway from each side. From the front, the real room shows. From the back, the source's front room
  shows, with the pink shimmer and the glow on that side. Walking in is a hard cut. Take one screenshot of each side.
- [ ] **Step 4: Write D38** in `docs/open-decisions.md` (Resolved, dated 2026-11-19, linking the spec). Cover the rule
  (strict photons), the rejected looks, the per-person setting, near under either rule with Task 2's numbers, the
  on-demand bake with Step 2's numbers, the pink on the window side, the hard cut, and touch staying classic. Add one
  line to AGENTS.md's Portals gotcha: sight and light go through `room.sightPortals()`, movement through
  `room.portals()`, and nearness through `isNearEitherWay`. Set the spec's status to `built`.
- [ ] **Step 5: Run** `pnpm exec biome check --write .`, `pnpm typecheck`, `pnpm lint` and `pnpm test`, and expect PASS.
- [ ] **Step 6: Commit** `Record D38: realistic portals`.
