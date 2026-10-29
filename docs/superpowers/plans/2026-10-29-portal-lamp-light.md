# Portal Lamp Light Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With portals on, the room's baked lamp light follows the portals: each spot is lit by the lamps it sees, the
way it sees them, through one portal at most.

**Architecture:** A second `Lighting` per room, `bakePortalLighting(plain, portals, …)`. It lists the real lamps plus a
**copy** of each lamp behind every doorway it can be seen through (`Light.through` = that portal's index). Every sight
test to a lamp goes through one helper, `seesLamp`. That helper is portal-aware: it uses the shared
`hasLineOfSightThrough` for copies, and `hasPortalLineOfSight` for real lamps. With `portals === null` it is exactly
`hasLineOfSight`, so the plain bake is unchanged bit for bit. The room keeps both tables, and the frame reads the
portals-on one while the room's portals are on. Window passes already inherit `scene.lighting`.

**Tech Stack:** TypeScript, Vitest, Biome, esbuild benches (`pnpm bench:walls`, `pnpm bench:sprites`).

**Spec:** `docs/superpowers/specs/2026-10-29-portal-lamp-light-design.md` (builds on D27,
`docs/superpowers/specs/2026-10-28-portal-doorways-design.md`)

## Global Constraints

- **Portals off is unchanged.** Same results in every existing test, and the same pixels. The baselines to keep, taken
  on main at 2f50798:
  - `bench:walls` pixel hash `-601092469`, portals-off doorway hash `-1246551896`, crowd off `2075427884`;
  - `bench:sprites` hash `1236007431`, portals-off doorway scenes `-1373330069`.
- **Light follows sight** (spec §2.1).
  - A sight line crossing a plane front→back does not reach what is physically behind that doorway. Back→front
    crossings are ordinary.
  - The step in light at a window's plane is expected. It is never "fixed" by sending light both ways.
- **Copies go through one portal only.**
  - A copy never shows a ceiling fixture.
  - A copy is made for lamp `l` and portal `p` only when `l` lies on the back side of `p`'s destination,
    `(l − dest.c)·dest.n > 0`, and within `LAMP_SIGHT` (16 tiles) of the destination's centre.
- **Bounce light is not recalculated.** The portals-on table holds the very same `bounce` array object as the plain one.
- **The portals-on table is ready before it can be needed.** It is baked synchronously when the room is created. There
  is no "not ready" state.
- **No allocations** in the per-frame or per-column path. `directLight`, `shadeFloor` and the reflection readers are
  per-frame.
- **Code style:**
  - every `if`/`else`/`for`/`while` body is braced, in Biome style;
  - `.at()` over `arr[i] as T`;
  - names over comments, and comments say only why (docs/code-style.md);
  - no "you/your" in identifiers, comments or test titles.

## Review Focus

1. **A spot on the doorway tile itself, right beside the plane.** On the front half, a lamp seen through the portal
   lights it, and the lamp physically behind does not. On the back half, the reverse. (Task 3,
   `the doorway tile's front half is lit through the portal, its back half is not`.)
2. **The main pass and the window passes must read one table per frame.** The table is chosen once, in `describeScene`.
   `frame.ts` already copies `scene.lighting` into each window level, so it must not be chosen anywhere else. (Task 5,
   `lighting(true) is the portals-on table, lighting(false) the plain one`.)
3. **Unlit rooms (`?lights=off`).** The plain table is null, so no portals-on table is baked, and nothing throws when
   portals flip. (Task 5, `an unlit room has no lighting with portals on or off`.)
4. **Per-frame shadow fallback.** A lamp a cell doesn't list falls back to `seenShare`. With copies, that fallback must
   be portal-aware, or a copy darkens floor physically near it behind the doorway. (Task 4,
   `a copy never shades floor it cannot be seen from`.)
5. **More than 127 lamps.** level1's 37 lamps plus their copies pass the old signed-byte limit, so a lamp index of 128
   or more must still be listed and read back. (Task 2, `lists a lamp whose index is past 127`.)

---

### Task 1: Line of sight through one named portal (shared)

**Files:**
- Modify: `packages/shared/src/portals/apparent.ts` (next to `passesThrough`, reusing it and its scratch)
- Test: `packages/shared/src/portals/apparent.test.ts`

**Interfaces:**
- Produces: `hasLineOfSightThrough(map: GameMap, p: Portals, index: number, ax: number, ay: number, bx: number, by: number): boolean`.
  It is true when all of these hold:
  - a→b crosses portal `index` front→back, inside its opening, as the first front→back crossing (`crossedPortal`);
  - a up to the crossing is a line of sight (`hasLineOfSight`);
  - from the crossing carried through `toDest`, to b carried through `toDest`, is a `hasPortalLineOfSight`.
  Exported from `@zoom3d/shared` through the existing `export * from './portals/apparent'`.

- [ ] **Step 1: Write the failing tests** in a new `describe('hasLineOfSightThrough')`. Use the existing
  `twoDoorways()` fixture (hall width 7; A at (2, 3) with its front north; B at (4, 3) with its front south; the
  `atoB` half turn is (x, y) → (7 − x, 7 − y)):

```ts
const { map, portals } = twoDoorways();
test('sees a point behind A through A, from A’s front', () => {
  // The copy of a lamp at (4.5, 1.5), north of B: (2.5, 5.5).
  expect(hasLineOfSightThrough(map, portals, 0, 2.5, 1.5, 2.5, 5.5)).toBe(true);
});
test('is false from A’s back side, where the segment never crosses A front to back', () => {
  expect(hasLineOfSightThrough(map, portals, 0, 2.5, 4.5, 2.5, 5.5)).toBe(false);
});
test('is false for the wrong portal', () => {
  expect(hasLineOfSightThrough(map, portals, 1, 2.5, 1.5, 2.5, 5.5)).toBe(false);
});
test('is false when the segment meets A’s plane outside its opening', () => {
  expect(hasLineOfSightThrough(map, portals, 0, 1.2, 1.5, 3.9, 5.5)).toBe(false);
});
```

- [ ] **Step 2: Run** `pnpm --filter @zoom3d/shared exec vitest run src/portals/apparent.test.ts`. Expected: FAIL,
  `hasLineOfSightThrough` is not exported.
- [ ] **Step 3: Implement `hasLineOfSightThrough`** with `passesThrough(map, p, index, ax, ay, bx, by)` and then
  `chain.sees && hasPortalLineOfSight(map, p, hop.x, hop.y, aim.x, aim.y)`. Set `chain.sees = true` first, as
  `chainCounts` does. Allocate nothing.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then run `pnpm --filter @zoom3d/shared test` and
  `pnpm typecheck`, both green.
- [ ] **Step 5: Commit** `git commit -m "Add line of sight through one named portal"`

### Task 2: Lamp lists past 127 lamps

**Files:**
- Modify: `apps/web/src/renderer/lighting.ts`:
  - `LampList.lamps`, `Lighting.wallLamp` and `Lighting.floorLamp` become `Int16Array`;
  - `MAX_LAMPS` becomes `32767`;
  - the doc comment above `MAX_LAMPS` says "signed 16-bit".
- Modify: `apps/web/bench/walls.ts` (`lightingHash`)
- Test: `apps/web/src/renderer/lighting.test.ts`

**Interfaces:**
- Produces: `Lighting.wallLamp: Int16Array` and `Lighting.floorLamp: Int16Array`, with −1 for none, as before.

- [ ] **Step 1: Make `lightingHash` fold `wallLamp` and `floorLamp` element by element**, not by their bytes, so the
  hash doesn't depend on the element width. Run `pnpm bench:walls` and note the new lighting hash. The pixel hash must
  still be `-601092469`. Commit `git commit -m "Hash the lamp lists by value in bench:walls"`.
- [ ] **Step 2: Write the failing test** in `describe('bakeLighting floor lamps')`:

```ts
test('lists a lamp whose index is past 127', () => {
  // 200 lamps far east, but lamp 150 nearest the cell at (1.5, 2.5).
  const lamps = Array.from({ length: 200 }, (_, i) => (i === 150 ? lamp(4.5, 2.5) : lamp(5.5, 2.5)));
  const lm = bakeLighting(map, lamps, 0.45, GREY, GREY);
  const cell = Math.floor(2.5 * FLOOR_SUB) * lm.stride + Math.floor(1.5 * FLOOR_SUB);
  const listed = lm.floorLamp.slice(cell * REFLECTION_LAMPS, (cell + 1) * REFLECTION_LAMPS);
  expect(listed).toBeInstanceOf(Int16Array);
  expect([...listed]).toContain(150);
});
```

- [ ] **Step 3: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/lighting.test.ts`. Expected: FAIL. It
  throws on 200 lamps, or the array is an `Int8Array`.
- [ ] **Step 4: Change the three arrays to `Int16Array` and set `MAX_LAMPS = 32767`.** The readers in `walls.ts` and
  `object-shadows.ts` only compare and index, so they need no change beyond types.
- [ ] **Step 5: Run** the test file (PASS), then `pnpm test`, `pnpm typecheck` and `pnpm lint`. Then run
  `pnpm bench:walls`: the lighting hash must equal the one from Step 1, and every pixel hash must equal the Global
  Constraints baselines.
- [ ] **Step 6: Commit** `git commit -m "Let a map have more than 127 lamps"`

### Task 3: The portals-on bake

**Files:**
- Modify: `apps/web/src/renderer/lighting.ts`
- Create: `apps/web/src/renderer/test-portals.ts`. This is a test fixture: the `twoDoorways()` hall from
  `packages/shared/src/portals/test-doorways.ts` (not exported by the package), rebuilt as
  `portalHall(): { map: GameMap; portals: Portals }`. Same layout, same `atoB` (cos −1, sin 0, tx 7, ty 7).
- Test: `apps/web/src/renderer/lighting.test.ts`

**Interfaces:**
- Consumes: `hasLineOfSightThrough` (Task 1); `hasPortalLineOfSight`, `applyPoint` and `Portals` from
  `@zoom3d/shared`.
- Produces:
  - `Light.through?: number`: the index of the portal a copy is seen through. It is absent on a real lamp.
  - `Lighting.portals: Portals | null`: `null` from `bakeLighting`.
  - `lampCopies(lights: readonly Light[], portals: Portals): Light[]`: the real lamps first, unchanged and in order,
    then one copy per (lamp, portal) pair that passes the Global Constraints rule. A copy is placed at
    `applyPoint(portal.fromDest, l.x, l.y)`, has `through` set to the portal's index, and keeps every other field.
  - `seesLamp(map: GameMap, portals: Portals | null, l: Light, ax: number, ay: number, bx: number, by: number): boolean`:
    whether (ax, ay) sees the point (bx, by) of lamp `l`'s disc.
    - For a copy: `hasLineOfSightThrough(map, portals, l.through, …)`.
    - Otherwise: `hasPortalLineOfSight(map, portals, …)`, which with `portals === null` is `hasLineOfSight`.
  - `seenShare(map: GameMap, portals: Portals | null, x: number, y: number, l: Light): number` gains the `portals`
    parameter, and uses `seesLamp` for its `sees(t)`.
  - `bakePortalLighting(plain: Lighting, portals: Portals, floorColour: number, ceilingColour: number): Lighting`.
    It uses `lights = lampCopies(plain.lights, portals)` and `bounce = plain.bounce` (the same object). Every sight
    test goes through `seesLamp`, and ceiling fixtures come only from lamps with `through === undefined`.

- [ ] **Step 1: Write the failing tests** in a new `describe('bakePortalLighting')`. Use `portalHall()`, `GREY`, and
  two helpers: `floorAt(lm, x, y)` reads the red channel of `lm.floor` at the cell holding (x, y), and `ceilingAt` does
  the same for `lm.ceiling`.

```ts
const { map: hall, portals } = portalHall();
const light = (x: number, y: number, radius = 4): Light => ({ x, y, z: 0.85, radius, r: 1, g: 1, b: 1 });
const both = (lights: Light[]) => {
  const plain = bakeLighting(hall, lights, 0.1, GREY, GREY);
  return { plain, portal: bakePortalLighting(plain, portals, GREY, GREY) };
};

test('copies a lamp behind each doorway it can be seen through, and only there', () => {
  const copies = lampCopies([light(4.5, 1.5)], portals);
  expect(copies).toHaveLength(2);
  expect(copies.at(1)).toMatchObject({ x: 2.5, y: 5.5, through: 0 });
});
test('a lamp physically behind A no longer lights the floor in front of A', () => {
  const { plain, portal } = both([light(2.5, 5)]);
  expect(floorAt(plain, 2.5, 2.5)).toBeGreaterThan(floorAt(portal, 2.5, 2.5));
  expect(floorAt(portal, 2.5, 2.5)).toBe(floorAt(both([]).portal, 2.5, 2.5));
});
test('the floor in front of B is lit by the lamp seen through B', () => {
  const { plain, portal } = both([light(2.5, 5)]);
  expect(floorAt(portal, 4.5, 4.5)).toBeGreaterThan(floorAt(plain, 4.5, 4.5));
});
test('the doorway tile’s front half is lit through the portal, its back half is not', () => {
  // Lamp at (4.5, 3.0) just north of B, radius 1.8; its copy through A is (2.5, 4.0).
  const { portal } = both([light(4.5, 3.0, 1.8)]);
  const dark = both([]).portal;
  expect(floorAt(portal, 2.5, 3.3)).toBeGreaterThan(floorAt(dark, 2.5, 3.3));
  expect(floorAt(portal, 2.5, 3.7)).toBe(floorAt(dark, 2.5, 3.7));
});
test('a copy shows no fixture on the ceiling', () => {
  const { portal } = both([light(4.5, 1.5)]);
  expect(ceilingAt(portal, 2.5, 5.5)).not.toBe(ceilingAt(portal, 4.5, 1.5));
});
test('reuses the plain bounce light', () => {
  const plain = bakeLighting(hall, [light(4.5, 1.5)], 0.1, GREY, GREY, { wallColours: [GREY, GREY], strength: 1 });
  expect(bakePortalLighting(plain, portals, GREY, GREY).bounce).toBe(plain.bounce);
});
test('the plain bake is not portal-aware', () => {
  expect(bakeLighting(hall, [], 0.1, GREY, GREY).portals).toBeNull();
});
```

  If a value in these tests turns out to sit exactly on a cell edge, move the probe point by one cell (1/8 tile) on
  the same side and say so in the report. Don't change what the test asserts.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/lighting.test.ts`. Expected: FAIL, the
  new exports are missing.
- [ ] **Step 3: Implement** `lampCopies`, `seesLamp`, the `seenShare` signature and `bakePortalLighting`.
  - `BakeInput` gains `portals: Portals | null`.
  - `bakeLighting` passes `null`, and `bakePortalLighting` passes `portals` and the plain table's bounce, skipping
    `bakeBounce`.
  - `bakeLampSight` and both `seenShare` calls in the wall and floor bakes use `seesLamp`.
  - Leave `lampsOn` (inside the bounce bake) alone.
  - The fixture check in `bakeFloorAndCeiling` also requires `l.through === undefined`.
  - Update `object-shadows.ts`'s `seenShare` call to pass `lm.portals`. Its behaviour is Task 4's.
- [ ] **Step 4: Run** the test file (PASS), then `pnpm test`, `pnpm typecheck` and `pnpm lint`. Then run
  `pnpm bench:walls`: the lighting hash must equal Task 2's, and every pixel hash must equal the baselines.
- [ ] **Step 5: Commit** `git commit -m "Bake a room's lamp light with portals on"`

### Task 4: Per-frame lamp sight with portals

**Files:**
- Modify: `apps/web/src/renderer/lighting.ts` (`directLight`)
- Modify: `apps/web/src/renderer/object-shadows.ts` (`shadeCell`'s fallback, already passing `lm.portals` from
  Task 3)
- Test: `apps/web/src/renderer/lighting.test.ts`, `apps/web/src/renderer/object-shadows.test.ts`

**Interfaces:**
- Consumes: `seesLamp`, `bakePortalLighting` and `portalHall` (Task 3).
- Produces: `directLight` tests sight with `seesLamp(lm.map, lm.portals, l, x, y, l.x, l.y)`. Its signature is
  unchanged.

- [ ] **Step 1: Write the failing tests.** In `describe('directLight')`:

```ts
test('a lamp reached only by crossing a plane front to back leaves the object unlit', () => {
  const plain = bakeLighting(hall, [light(2.5, 5)], 0.1, GREY, GREY);
  const out = new Float64Array(18);
  directLight(bakePortalLighting(plain, portals, GREY, GREY), 2.5, 2.5, 0.5, 0, out);
  expect(out[DIR_TOP * 3]).toBe(0);
});
test('a lamp seen through a portal lights the object', () => {
  // Out of the real lamp's reach, in reach of its copy at (2.5, 4.0).
  const plain = bakeLighting(hall, [light(4.5, 3.0, 1.8)], 0.1, GREY, GREY);
  const out = new Float64Array(18);
  directLight(plain, 2.5, 2.6, 0.5, 0, out);
  expect(out[DIR_TOP * 3]).toBe(0);
  directLight(bakePortalLighting(plain, portals, GREY, GREY), 2.5, 2.6, 0.5, 0, out);
  expect(out[DIR_TOP * 3]).toBeGreaterThan(0);
});
```

  In `object-shadows.test.ts`, add `a copy never shades floor it cannot be seen from`, through `shadeFloor`.
  - Setup: `portalHall()`, a lamp at (4.5, 1.5) (its copy lies at (2.5, 5.5), behind A), and one voxel object standing
    at (2.5, 5.0), physically beside the copy.
  - Assert that with the portals-on table, no floor cell south of the wall row (y > 4) loses light to the copy: every
    cell there equals the unshaded table, apart from shading by the real lamp.
  - The simplest form: a table whose only lamp's copy is the only lamp reaching that floor.
- [ ] **Step 2: Run** both test files. Expected: FAIL. `directLight` still uses `hasLineOfSight`, and the fallback
  shades by the copy's straight-line share.
- [ ] **Step 3: Implement.**
  - `directLight` uses `seesLamp`.
  - `shadeCell`'s fallback `seenShare(lm.map, lm.portals, x, y, l)` must now return 0 for a copy the cell cannot see.
    Check that, and fix it if the Task 3 change alone doesn't.
  - Allocate nothing.
- [ ] **Step 4: Run** both files (PASS), then `pnpm test`, `pnpm typecheck` and `pnpm lint`. Then run
  `pnpm bench:sprites`: the hash is `1236007431`, and the portals-off doorway scenes give `-1373330069`.
- [ ] **Step 5: Commit** `git commit -m "Light people and objects, and their shadows, through portals"`

### Task 5: The room picks its table

**Files:**
- Modify: `apps/web/src/renderer/room-lighting.ts`
- Modify: `apps/web/src/game/room.ts` (`JoinOptions`, `Room`, `joinRoom`)
- Modify: `apps/web/src/game/game.ts` (passes `lighting: roomLighting` into `joinRoom`)
- Modify: `apps/web/src/game/room-loop.ts` (`describeScene`)
- Test: `apps/web/src/renderer/room-lighting.test.ts` (create)

**Interfaces:**
- Consumes: `bakePortalLighting` (Task 3), `wirePortals`.
- Produces:
  - `createRoomLighting(plain: Lighting | null, portals: Portals): { lighting(portalsOn: boolean): Lighting | null }`.
    It bakes the portals-on table immediately, when `plain` isn't null, using the same `FLOOR` and `CEILING` as the
    plain bake.
  - `JoinOptions.lighting: () => Lighting | null`, the page's plain table (game.ts's `roomLighting`).
  - `Room.lighting(): Lighting | null`, the table for this frame: the portals-on one while `portals()` isn't null.
  - `joinRoom` wires the room's portals eagerly (`wirePortals(opts.map, opts.roomId)`, kept for `portals()` too) and
    calls `createRoomLighting` before `connectSession`, so the table exists before any welcome is handled.
  - `describeScene` sets `scene.lighting = reflections === null ? null : (room?.lighting() ?? o.roomLighting())`.
    Nothing else picks a table; `frame.ts` already gives window passes `scene.lighting`.

- [ ] **Step 1: Write the failing tests** in `room-lighting.test.ts`, on `portalHall()` and a one-lamp plain
  `bakeLighting`:
  - `lighting(true) is the portals-on table, lighting(false) the plain one`: assert
    `lighting(false) === plain`, `lighting(true) !== plain`, and `lighting(true)?.portals === portals`. Calling
    `lighting(true)` twice returns the same object.
  - `an unlit room has no lighting with portals on or off`: `createRoomLighting(null, portals)` gives null both ways.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/room-lighting.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `createRoomLighting` and the room, game and loop wiring above.
- [ ] **Step 4: Run** the test (PASS), then `pnpm test`, `pnpm typecheck`, `pnpm lint` and
  `pnpm --filter @zoom3d/web exec playwright test e2e/portals.spec.ts`. Expected: all green.
- [ ] **Step 5: Commit** `git commit -m "Light the room with the portals-on table while portals are on"`

### Task 6: Measure and record

**Files:**
- Modify: `apps/web/bench/walls.ts`
- Modify: `docs/open-decisions.md` (new D28; one line under D27's gaps)
- Modify: `AGENTS.md` (the Portals gotcha)

- [ ] **Step 1: In `bench/walls.ts`, bake `bakePortalLighting(lighting, portals, FLOOR, CEILING)` once.**
  - Print its cold bake time, the number of lamps with copies, and its lighting hash, on one line starting
    `portal lighting:`.
  - Use it for the portals-on frames, both the doorway poses and the crowd.
  - The portals-off hashes must stay at the baselines. The portals-on hashes will change: print them.
- [ ] **Step 2: Run** `pnpm bench:walls` and `pnpm bench:sprites`, and copy their output into the task report.
  - If the portals-on bake takes more than 300 ms, prune the copies before going on. A copy counts only if
    `bakeLampSight` finds some coarse cell that sees it. Re-measure after pruning.
  - Record both numbers, before and after.
- [ ] **Step 3: Write D28** in `docs/open-decisions.md`, after D27, in D27's form. It covers:
  - the rule (light follows sight, the step accepted, the user's reason, rule 2 rejected);
  - copies through one portal, and the copy rule;
  - the second table per room, baked at room creation, with bounce reused;
  - the lamp index widening;
  - the measured bake time, copy count and frame times, against `2f50798`.
  Under D27's known gaps, add: "The baked lamp light follows the portals since D28; moving shadows and avatar glow
  through portals don't yet." Move nothing else.
- [ ] **Step 4: Extend the Portals gotcha in `AGENTS.md`** with one sentence: "With portals on, the room's light is a
  second table (`bakePortalLighting`) whose lamp list holds copies seen through one portal (`Light.through`); any new
  sight test to a lamp goes through `seesLamp`."
- [ ] **Step 5: Run** `pnpm lint`. Then commit
  `git commit -m "Measure and record the portal lamp light (D28)"`.
