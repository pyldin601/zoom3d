# Slow Light for Everything Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With slow light on, every remote thing (and the own image through portals) is seen by one rule: state,
face and look as late as its light, its own motion shifting colour and turning models, and the lamps' switching
travelling lamp → place → eye.

**Architecture:** `RemoteWorld` computes one seen record per thing per frame (light time, lateness, pose, velocity)
and reads small rings of state at it; faces keep a downscaled frame history; moving things carry a Doppler shift (in the
source frame's alpha byte, read by the bend) and a Terrell turn; a light timeline in the room loop drives a wave lighting
table re-summed from per-lamp shares, and a masked copy of the sight portals opens doorways by distance.

**Tech Stack:** TypeScript, Vitest, Biome, the software renderer in `apps/web/src/renderer`.

**Spec:** `docs/superpowers/specs/2026-11-23-slow-light-everything-design.md`

## Global Constraints

- Light *Instant* draws today's frame pixel for pixel: `pnpm bench:walls` and `pnpm bench:sprites` hashes equal the
  baselines taken on `main` before Task 1 (`scratchpad/base-walls.txt`, `scratchpad/base-sprites.txt`).
- No allocation per frame or per column; rings and tables are allocated once, when the look first needs them.
- Nothing on the wire, no server change; gameplay and sounds read live state.
- `MAX_BETA` 0.5 caps a thing's β as it caps the eye's.
- Repo style: Biome (`pnpm exec biome check --write .`), braced bodies, `.at()` over index casts, comments only say why,
  no "you/your" in identifiers.

## Review Focus

1. A peer leaving while slow light is on: their disc must vanish once their light passes, never linger forever or throw
   when media is gone (Task 1 test "a departed peer is drawn until its light passes, then forgotten").
2. Slow light turned off mid-wave or mid-delay: the next frame is today's (live state, room table, full portals) — Task 1
   and Task 4 each test "off returns the live state / room table".
3. A thing moving faster than c (riding at c = 6): β capped, no NaN or out-of-table shift (Task 2 test "β above the
   cap gives the cap's shift").
4. A face whose camera turns off while it is seen late: the avatar shows once the off reaches the eye, not before (Task 3).
5. Y pressed twice quickly: the second wave starts while the first spreads; each place still follows the timeline
   (Task 4 test "two changes close together").

---

### Task 1: Seen state

**Files:**
- Create: `apps/web/src/game/seen-state.ts`, `apps/web/src/game/seen-state.test.ts`
- Modify: `apps/web/src/net/session.ts` (`since` on `RemotePeer` and `RemoteObject`), `apps/web/src/game/remote-world.ts`,
  `apps/web/src/game/remote-world.test.ts`

**Interfaces:**
- Produces: `interface PeerLook { held: HeldItem | null; boombox: boolean; riding: string | null; mic: boolean;
  gesture: RemotePeer['gesture'] }`; `createStateRing<T>(capacity: number, blank: () => T, copy: (from: T, to: T) => void,
  same: (a: T, b: T) => boolean): StateRing<T>` with `push(t: number, value: T): void` (only when different from the
  newest) and `at(t: number): T` (newest at or before t, else oldest). `RemotePeer.since` / `RemoteObject.since` (ms;
  `-Infinity` from a welcome). `RemoteWorld` keeps, per thing, `lateMs` and a seen velocity (`{ vx, vy }` tiles/s), read
  by Task 2 through `seenOf(key): Seen | undefined` with `interface Seen { lateMs: number; vx: number; vy: number;
  image: Apparent | null }`.

- [ ] **Step 1: Write failing tests** in `seen-state.test.ts`: `push` keeps one entry while values repeat; `at` returns
  the newest at or before t, the oldest before all. In `remote-world.test.ts` (light at c = 6, peer 6 tiles away, so
  `lateMs` = 1000): "a held lighter switched on now is seen only after the light time" (no lighter in `world.lighters`
  at +500 ms, one at +1100 ms); "a gesture is played from its seen start"; "a peer who joins now is unseen until its light
  arrives, one from the welcome at once"; "a departed peer is drawn until its light passes, then forgotten"; "stepping
  on a scooter swaps the parked one for the ridden one at one light time"; "the ball's heldBy is seen late and its trail
  has no gap over a hold"; "off returns the live state".
- [ ] **Step 2:** `pnpm --filter @zoom3d/web exec vitest run src/game/seen-state.test.ts src/game/remote-world.test.ts`
  → the new tests FAIL.
- [ ] **Step 3: Implement.** `session.ts`: `since: now()` in `peer_joined` and the `peer_ride` park, `-Infinity` in the
  welcome. `remote-world.ts`: per peer a `StateRing<PeerLook>` (capacity 32) pushed each sample when light is on; a
  ball `StateRing` of `heldBy`; departed peers and objects kept in a pooled list with `goneAt` until `seenNow ≥ goneAt`;
  `seenNow = now − lateMs`, `lateMs = drawnAt − lightLeftAt`; velocity from two buffer samples 150 ms apart
  (`VELOCITY_WINDOW_MS`), 0 across a jump. `fillSprite`, lighters, headlights, `handsFull`, the ridden scooter and
  `fillLabel`'s mic read the seen look when light is on, live state when off. The ball trail is pushed every frame.
- [ ] **Step 4:** the same command → PASS; `pnpm test` → all pass.
- [ ] **Step 5: Commit** "See remote people's and objects' state as late as their light".

### Task 2: Moving things look moving

**Files:**
- Modify: `apps/web/src/renderer/slow-light-math.ts` (+ test), `apps/web/src/renderer/spectrum.ts` (+ test),
  `apps/web/src/renderer/sprites.ts`, `apps/web/src/renderer/held-items.ts`, `apps/web/src/renderer/voxels.ts`,
  `apps/web/src/renderer/slow-light.ts` (+ test), `apps/web/src/game/remote-world.ts` (+ test)

**Interfaces:**
- Consumes: `RemoteWorld.seenOf` (Task 1).
- Produces: `sourceDoppler(vx: number, vy: number, nx: number, ny: number, c: number): number` (D, β capped at
  `MAX_BETA`); `terrellTurn(vx: number, vy: number, nx: number, ny: number, c: number): number` (radians to add to a
  model's angle); `shiftSteps(d: number): number` (whole table steps, 0 at D = 1, within ±127); `Sprite.shift`,
  `VoxelInstance.shift` and `VoxelInstance.turn` (all 0 by default); `encodeShift(colour: number, steps: number): number`
  and `shiftOf(pixel: number): number` in `spectrum.ts`.
- Ruling (plan): the shift travels in the source pixel's alpha byte (0xFF = no shift) instead of a separate plane: window
  rows copy it for free, the output frame is written by the bend, and pixels of things at rest keep alpha 0xFF, so off is
  untouched by construction. Draw loops apply it only when the thing's shift is non-zero.

- [ ] **Step 1: Failing tests.** `sourceDoppler` is 1 at rest, > 1 approaching (v toward n), < 1 receding, and "β above
  the cap gives the cap's shift" (v = 12, c = 6 equals v = 3, c = 6). `terrellTurn`: 0 head-on, `asin(β)` crossing,
  its sign shows the back (the model turns so its rear faces the eye). Spectrum: the widened table (ln D ∈ [ln ¼, ln 4])
  is the identity at `dopplerIndex(1)`; `shiftOf(encodeShift(c, s)) === s` for s in −127..127 and `shiftOf(0xff000000 |
  c) === 0`. Bend: "a source pixel carrying a shift reads bluer and brighter than its neighbour at rest". Remote world:
  "a peer walking toward the eye has a positive shift, away negative; a crossing scooter is turned".
- [ ] **Step 2:** run the four test files → new tests FAIL.
- [ ] **Step 3: Implement** the maths, the table range (`DOPPLER_STEPS` 513), alpha encoding in the disc, held-item and
  voxel pixel writes (only when shift ≠ 0), `angle + turn` where voxels project (model and mirror; lamp shadows keep
  `angle`), the bend adding `shiftOf(pixel)` to `d`, and `RemoteWorld.collect` filling `shift`/`turn` from `seenOf`
  (velocity turned by the image's `cos/sin`, `n̂` from the image to the eye).
- [ ] **Step 4:** tests PASS; `pnpm test`; `pnpm bench:walls` and `pnpm bench:sprites` hashes equal the baselines.
- [ ] **Step 5: Commit** "Shift and turn moving things by their own motion under slow light".

### Task 3: Seen faces

**Files:**
- Create: `apps/web/src/media/face-history.ts`, `apps/web/src/media/face-history.test.ts`
- Modify: `apps/web/src/media/faces.ts`, `apps/web/src/media/call.ts`, `apps/web/src/game/remote-world.ts`,
  `apps/web/src/game/room-loop.ts`, `apps/web/src/renderer/sprites.ts`, `apps/web/src/renderer/glow.ts`

**Interfaces:**
- Produces: `createFaceHistory(): FaceHistory` with `record(t: number, texels: Uint32Array /* FACE_SIZE² */): void`,
  `mark(t: number, showing: 'live' | 'fallback'): void`, `at(t: number): { texels: Uint32Array; size: number } | null`
  (null: show the fallback); rings 128² × 32 (~1 s) and 64² × 128 (every other frame, ~8 s). `FaceSource.history(on:
  boolean)`, `FaceSource.seen(lateMs: number): { texels: Uint32Array; size: number }`. `Call.faceOf(id, lateMs = 0)`
  returns `{ texels, size } | null`; `PeerMedia.faceOf(id, lateMs)`. `Sprite.faceSize` (FACE_SIZE for live texels).
- [ ] **Step 1: Failing tests:** `at` picks the newest frame at or before t across both rings; before the oldest, the
  oldest; a `fallback` mark makes `at` return null from its time; downscaling a flat colour keeps it. Sprites: "a disc
  draws a 64² face" (face size from `faceSize`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**; the call turns histories on and off from the room loop's light (`call.setFaceHistory(on)`);
  `seen(lateMs)` gives live texels under one frame (≤ 33 ms).
- [ ] **Step 4:** PASS; `pnpm test`; bench hashes unchanged.
- [ ] **Step 5: Commit** "See faces as late as their light".

### Task 4: The lights-out wave

**Files:**
- Create: `apps/web/src/game/light-timeline.ts` (+ test), `apps/web/src/renderer/light-wave.ts` (+ test)
- Modify: `apps/web/src/renderer/lighting.ts` (optional `Lighting.wave` hook read by `ambientAt` and `directLight`),
  `apps/web/src/renderer/object-shadows.ts`, `apps/web/src/game/room-loop.ts`, `apps/web/src/game/room.ts`

**Interfaces:**
- Produces: `createLightTimeline(capacity = 16)` with `record(t: number, lighting: Lighting | null, sight: Portals |
  null): void` (pushes on change), `reset(t, lighting, sight)`, `at(t): { lighting: Lighting | null; sight: Portals |
  null }`, `changedSince(t: number): boolean`. `createLightWave(tables: readonly Lighting[]): LightWave` (bakes per-lamp
  shares, CSR per table) with `update(timeline, eye: Point, now: number, c: number): Lighting` (the wave table).
  `Lighting.wave?: { lampLit(index: number, x: number, y: number): boolean; ambientInto(x: number, y: number, out:
  Float64Array): void }`.
- [ ] **Step 1: Failing tests:** a place lit by one lamp goes dark at the switch + (|lamp→P| + |P→eye|)/c and not
  before; lit by two, two steps, nearer lamp first; switching on, the reverse; every lamp lit re-sums to the baked table
  within one byte per channel; a lamp's reflection slot reads 0 seen while it is out; "two changes close together";
  timeline `at` before the oldest gives the oldest; "off returns the room table".
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Ambient at a place follows the table seen along its brightest lamp's path (eye distance
  alone with no lamp), ruled in the ledger. The room loop records the instant pair every frame while light is on,
  resets on look change or turning the look on, and hands `scene.lighting` the wave table while `changedSince(now −
  2·diagonal/c)`. Per-lamp shares bake lazily when slow light first runs in the room.
- [ ] **Step 4:** PASS; `pnpm test`; bench hashes unchanged.
- [ ] **Step 5: Commit** "Spread the lamps' switching lamp to place to eye under slow light".

### Task 5: Doorways open by distance

**Files:**
- Modify: `packages/shared/src/portals/wiring.ts` (optional `Portals.open?: Uint8Array`),
  `packages/shared/src/portals/apparent.ts`, `apps/web/src/renderer/glow.ts`, `apps/web/src/renderer/frame-eyes.ts`,
  `apps/web/src/game/light-timeline.ts`, `apps/web/src/game/room-loop.ts`

**Interfaces:**
- Produces: `seenPortals(timeline, full: Portals, eye: Point, now: number, c: number): Portals | null` (a pooled masked
  copy, rebuilt only when a doorway changes; null when none is open).
- [ ] **Step 1: Failing tests:** a doorway opens when the change's light reaches the eye from its plane, nearer first;
  `apparentPosition` and portal glows skip closed portals; `open` absent behaves as today.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**; the scene, bend and light delay read the seen portals while the wave runs; hums keep the
  live set.
- [ ] **Step 4:** PASS; `pnpm test`; bench hashes unchanged.
- [ ] **Step 5: Commit** "Open doorways as late as their light".

### Task 6: The own image through portals

**Files:**
- Modify: `apps/web/src/game/room-loop.ts`, `apps/web/src/game/local-player.ts` (+ tests)

**Interfaces:**
- Consumes: `StateRing` (Task 1), `sourceDoppler`/`terrellTurn`/`shiftSteps` (Task 2), `createFaceHistory` (Task 3).
- [ ] **Step 1: Failing tests:** the own disc seen through a window shows the item held at its light time, its shift
  from the own velocity, the own scooter turned.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** in `delayOwnImage` (an own `PeerLook` ring, own face history fed from the camera texels).
- [ ] **Step 4:** PASS; `pnpm test`.
- [ ] **Step 5: Commit** "Give the own image through portals the same slow light rule".

### Task 7: Records and checks

- [ ] D41 in `docs/open-decisions.md`, an AGENTS.md gotcha line, the spec's status "built", measured costs.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, both benches (hashes and bent frame time).
- [ ] In a local room (`?bots=…`, c = 6): a bot passing shifts colour, a scooter turns, Y spreads the dark from lamps.
- [ ] Commit "Record D41: slow light for everything".
