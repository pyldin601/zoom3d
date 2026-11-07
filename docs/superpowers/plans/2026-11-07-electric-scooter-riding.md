# Electric Scooter Riding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The kick scooters become electric:
- throttle, coast, brake then reverse;
- A/D steer;
- items are put away while riding;
- a first-person handlebar;
- a speed-pitched motor whine;
- a glowing headlight.

**Architecture:** The ride physics is one pure client-side function (`stepRide`) that `LocalPlayer.walk` uses while
riding. Everything else is derived on each screen from state it already has (`riding`, drawn positions), so the server
and protocol don't change. The whine is a Web Audio synth like the vacuum's: spatial for others, unplaced for the rider.

**Tech Stack:** TypeScript, vitest (with `audio/fake-audio.ts`), Canvas2D pixel sprites, Web Audio, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-electric-scooter-riding-design.md` (builds on
`2026-11-07-kick-scooter-design.md`)

## Global Constraints

- No server, protocol or `PROTOCOL_VERSION` change. `RIDE_SPEED` (6) stays the top speed and the move check is
  unchanged.
- **Ride constants** (starting values, in `game/scooter-physics.ts`):
  - throttle 4 tiles/s²;
  - coast 1.5 tiles/s²;
  - brake 10 tiles/s²;
  - reverse top −1 tile/s at 3 tiles/s²;
  - key turn rate `TURN_SPEED × (1 − 0.4 × |speed| / RIDE_SPEED)`;
  - head-on = within 20° of a wall's normal;
  - scraping slows at the brake rate.
- The mouse and touch drags turn the scooter instantly (owner). Only keys get the speed-limited turn.
- **Whine:** 180 Hz at a crawl to 720 Hz at `RIDE_SPEED`. Silent below 0.3 tiles/s, ×1.3 while speeding up, smoothed
  with a 0.1 s time constant. `SCOOTER_GAIN` 0.04.
- Riders never bob. While riding, held items, the boombox sprite and the lighter's light are hidden on every screen.
  The choice isn't changed or sent, and the music keeps playing.
- No allocations per frame (AGENTS.md); `.at()`; braced blocks; comments say why; Biome.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Stepping off at speed, then on again:** the new ride starts at speed 0, never with the old speed. Test in Task 1.
2. **Tab hidden mid-ride (rAF stops), then shown:** the first `dt` is clamped by `MAX_STEP_S`, so no lurch through a
   wall. Test in Task 1.
3. **A rider crosses a portal, or a correction or teleport moves them:** others' whine shows no speed spike (`JUMP_TILES`
   skip). Test in Task 4.
4. **A sip or cheers is under way when stepping on:** it is cancelled, and no sip key works while riding. Test in Task 2.
5. **A rider leaves the room while moving:** their whine stops and its node is detached. Test in Task 4.

---

### Task 1: Ride physics

**Files:**
- Create: `apps/web/src/game/scooter-physics.ts`, `apps/web/src/game/scooter-physics.test.ts`
- Modify:
  - `apps/web/src/game/local-player.ts` (`walk` and `riding`)
  - `apps/web/src/game/scooter-ride.ts` (remove `forwardSpeed`)
  - `apps/web/src/game/room-loop.ts` (stop passing `forwardSpeed`)
  - `packages/shared/src/geometry/movement.ts` (remove the `forwardSpeed` parameter, and its two tests in
    `movement.test.ts`; `RIDE_SPEED` stays)

**Interfaces:**
- Produces:
  - `interface RideState { speed: number }` (tiles/s along the heading; negative = backing up).
  - `createRideState(): RideState`.
  - `stepRide(map: GameMap, pose: PlayerState, ride: RideState, input: MoveInput, dt: number, portals: Portals | null): void`.
    It mutates `pose` and `ride`, clamps `dt` to `MAX_STEP_S`, and adds `strafe` to `turn` (clamped).
  - `LocalPlayer.ride: RideState` (read-only property); `LocalPlayer.riding` setter: setting `true` from `false` resets
    `ride.speed` to 0.
  - `LocalPlayer.walk(map, move, turnRad, dt, portals?)` loses its `forwardSpeed` parameter.

**Behaviour:**
- Turn first: `pose.angle += turn × keyTurnRate(speed) × dt`.
- Then speed, by the spec's table.
- Then move `speed × dt` along the heading with `moveWithCollision`. A blocked axis is one where the intended delta was
  non-zero and the result kept the old coordinate.
  - Both axes blocked, or `|free share| / |step| < sin 20°`: `speed = 0`.
  - One axis blocked otherwise: `speed` moves toward 0 by `10 × dt`.
- Then `carryThroughPortal`.

- [ ] **Step 1: Write the failing tests** in `scooter-physics.test.ts`. Use an open map (`parseMap` of a 20 × 20 box)
  and step at 1/60 s unless a test says otherwise.
  - `throttle reaches RIDE_SPEED in about 1.5 s and never passes it`: after 1.4 s, speed < 6; after 1.6 s, `=== 6`;
    after 3 s still 6.
  - `coasting from full speed stops in about 4 s`: speed after 3.9 s > 0; after 4.1 s, 0.
  - `S brakes, then backs up no faster than 1 tile/s`: speed 6, then S: 0 within 0.62 s, then −1 after a further 1 s
    and never below −1.
  - `A and D steer`: with `strafe: 1` and no `turn`, the angle grows. On the same input, `pose.x` and `pose.y` only move
    along the heading.
  - `keys turn 60% as fast at full speed`: the angle change per step at speed 6 is 0.6× that at speed 0.
  - `a wall head-on stops it dead`: speed 6, heading straight at a wall 0.5 tiles away; after a step into it, speed 0.
  - `a wall within 20° of head-on stops it dead too`: heading 15° off the normal, speed 0 after contact.
  - `scraping a wall at 45° slows at the brake rate, frame-rate independent`: from speed 6, after 0.3 s of scraping,
    speed ≈ 3 (±0.05) both at dt 1/30 and at dt 1/144.
  - `a huge dt is clamped`: one step of 5 s at speed 6 moves at most `6 × MAX_STEP_S` (Review Focus 2).
  - `stepping on starts at rest`: in `local-player.test.ts`, ride at speed 6, set `riding = false`, then `riding = true`;
    `ride.speed === 0` (Review Focus 1).
  - `speed carries through a portal`: use the `twoDoorways` helper as in `local-player.test.ts`. Ride into a doorway at
    speed 4; the pose comes out at the destination with speed still ≈ 4.

- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/game/scooter-physics.test.ts src/game/local-player.test.ts`.
  Expected: FAIL (the module is missing).

- [ ] **Step 3: Implement** `stepRide` and wire it in:
  - `LocalPlayer.walk` calls `stepRide` while `riding`, else `stepPlayer`;
  - remove `forwardSpeed` from `stepPlayer`, `ScooterRide` (and its test) and `room-loop.ts`;
  - `local-player.ts`'s existing walking test still passes.

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** "Ride electric scooters with throttle, coasting, braking and steering"

### Task 2: Items put away while riding

**Files:**
- Modify:
  - `apps/web/src/game/remote-world.ts` (+ test)
  - `apps/web/src/game/local-player.ts` (+ test)
  - `apps/web/src/game/room-controls.ts`
  - `apps/web/src/renderer/frame.ts` (`FirstPerson` gains `riding`)

**Interfaces:**
- Consumes: `RemotePeer.info.riding` and `LocalPlayer.riding`.
- Produces: `FirstPerson.riding: boolean` and `FirstPerson.steer: number` (−1..1; Task 3 fills `steer`, and this task
  sets it to 0).

**Behaviour:**
- **Remote:** `fillSprite` sets `held` null and `boombox` false for a rider, and riders are left out of `lighters`.
- **Local:**
  - `avatar()` shows `held` null and `boombox` false while riding;
  - `lighter()` returns null while riding;
  - `firstPerson()` sets `riding`;
  - setting `riding = true` cancels the gesture under way.
- **Controls:** while `localPlayer.riding`, `drinkKey.down` is skipped (keys and touch), and the touch drink button gets
  `held: null`. The pick action still calls `chooseHeld`.

- [ ] **Step 1: Write the failing tests**
  - `remote-world.test.ts`:
    - `a rider shows no drink, boombox or lighter`: a rider with `held: 'lighter'` and `boombox: true`; the sprite has
      `held: null` and `boombox: false`, and `world.lighters` is empty;
    - `stepping off brings them back`.
  - `local-player.test.ts`:
    - `riding hides the own drink and lighter but keeps the choice`: holding a beer and riding, `avatar(...)?.held` is
      null and `firstPerson(0).riding` is true, while `localPlayer.held` is `'beer'`. With the lighter, `lighter()` is
      null;
    - `stepping on cancels a sip under way` (Review Focus 4): `gesture.start('sip', 0)`, then `riding = true`, then
      `gesture.kind(1)` is null.

- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/game/remote-world.test.ts src/game/local-player.test.ts`.
  Expected: FAIL.

- [ ] **Step 3: Implement** the behaviour above. `drawFirstPerson` draws nothing held while `riding` (Task 3 adds the
  bar).

- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck` and `pnpm lint`. Expected: PASS.

- [ ] **Step 5: Commit** "Put items away while riding a scooter"

### Task 3: The first-person handlebar

**Files:**
- Create: `apps/web/src/renderer/own-handlebar.ts`, `apps/web/src/renderer/own-handlebar.test.ts`
- Modify:
  - `apps/web/src/renderer/frame.ts` (`drawFirstPerson`)
  - `apps/web/src/game/local-player.ts` (`steer` easing)

**Interfaces:**
- Consumes: `FirstPerson.riding` and `FirstPerson.steer` (Task 2), and `ownTexel(fb)` and `blitHeldSprite` /
  `toHeldSprite` from `own-held.ts` and `held-items.ts`.
- Produces:
  - `renderOwnHandlebar(fb: Framebuffer, steer: number): void`;
  - `HANDLEBAR_TILT_TEXELS = 3`;
  - `HANDLEBAR_SHIFT = 0.02` (fraction of the width).
  - `LocalPlayer` eases `steer` toward the step's clamped `turn + strafe` input with τ 0.1 s, inside `walk` while riding,
    and holds it at 0 on foot.

**Behaviour:**
- Pixel art, built once with `toHeldSprite`:
  - a grey stem coming up from the bottom centre;
  - the bar across it;
  - dark grips at both ends;
  - the lower part cropped by the screen edge.
- `steer` > 0 (right) raises the left grip and lowers the right one by up to 3 texels, and shifts everything right by up
  to 2% of the width. A negative `steer` mirrors that.

- [ ] **Step 1: Write the failing tests** in `own-handlebar.test.ts`:
  - `draws at the bottom centre`: some pixels in the bottom fifth, centre columns, change; the top half is untouched;
  - `steering right shifts it right and tilts it`: the centroid of changed pixels at steer 1 is right of steer 0. The
    rightmost grip's lowest changed row is lower than at steer 0, and the leftmost grip's is higher;
  - `steer is symmetric`: the mirror image at −1;
  - `drawFirstPerson draws the bar only while riding`, in `frame.test.ts`: the bottom rows differ between `riding: true`
    and `riding: false` with nothing held.

- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/own-handlebar.test.ts src/renderer/frame.test.ts`.
  Expected: FAIL.

- [ ] **Step 3: Implement** `renderOwnHandlebar`, call it from `drawFirstPerson` when `riding`, and add the steer easing.

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** "Show the handlebar in first person while riding"

### Task 4: The motor's whine

**Files:**
- Create:
  - `apps/web/src/audio/scooter-sound.ts` (+ test): one synth
  - `apps/web/src/audio/scooter-sounds.ts` (+ test): per-rider manager and the own sound
- Modify:
  - `apps/web/src/game/room.ts` (`Room.scooterSounds`)
  - `apps/web/src/game/room-loop.ts` (sync every frame and from the hidden ticker, next to `objectSounds.sync`)

**Interfaces:**
- Produces:
  - `SCOOTER_GAIN = 0.04`;
  - `whinePitchHz(speed: number): number` (180 → 720 linearly over 0..`RIDE_SPEED`, clamped);
  - `whineLevel(speed: number, speedingUp: boolean): number` (0 below 0.3; else `|speed| / RIDE_SPEED`, ×1.3 when
    speeding up, capped at 1);
  - `createScooterSound(ctx: BaseAudioContext): { output: AudioNode; set(speed: number, speedingUp: boolean): void; dispose(): void }`,
    which uses `setTargetAtTime` with τ 0.1 for pitch and level;
  - `createScooterSounds(ctx, engine)` returning:
    - `sync(peers: ReadonlyMap<string, RemotePeer>, positions: ReadonlyMap<string, Point>, dtSeconds: number): void`;
    - `own(speed: number, speedingUp: boolean, riding: boolean): void`;
    - `peerLeft(id: string): void`.

**Behaviour:**
- **Others:** a sound starts for a peer whose `info.riding` is set. It is attached with `engine.attachNode('scooter:' +
  id, output, id)`, and a key per id is cached, with no per-frame strings.
- **Others' speed:**
  - the distance between this frame's and the last frame's drawn position, divided by `dt`;
  - a step over `JUMP_TILES` counts as 0;
  - smoothed with τ 0.15 s;
  - `speedingUp` means the smoothed speed rose by more than 0.5 tiles/s² over the frame.
- **Stopping:** the sound stops, detaches and is disposed when the peer stops riding or leaves.
- **Own:** an unplaced whine (`engine.playUnplaced`) created on stepping on and disposed on stepping off. It is fed
  `localPlayer.ride.speed`, with `speedingUp` true while the throttle raises the speed.

- [ ] **Step 1: Write the failing tests**
  - `scooter-sound.test.ts`:
    - `pitch climbs from 180 Hz to 720 Hz with speed`: the values at 0, 3 and 6, and clamped at 9;
    - `silent below 0.3 tiles/s`;
    - `louder while speeding up, capped at 1`;
    - `changes are smoothed`: after `set(6, false)`, the oscillator's and gain's last `targets` entries use τ 0.1.
  - `scooter-sounds.test.ts`, with `FakeAudioContext` and a recording engine:
    - `a peer stepping on gets a whine, stepping off loses it`: `attachNode` called once, then `detach`;
    - `a peer who leaves while riding is detached` (Review Focus 5);
    - `a portal jump is no speed` (Review Focus 3): positions jump 5 tiles in one frame, and the whine's level target
      stays 0;
    - `the own whine plays unplaced while riding and stops on stepping off`.

- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/audio/scooter-sound.test.ts src/audio/scooter-sounds.test.ts`.
  Expected: FAIL.

- [ ] **Step 3: Implement** it and wire it into `room.ts` and `room-loop.ts`. `peerLeft` hooks into the session
  listener's `peerLeft` as `lighterSounds` does.

- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck` and `pnpm lint`. Expected: PASS.

- [ ] **Step 5: Commit** "Give electric scooters a motor whine"

### Task 5: The look, e2e and docs

**Files:**
- Modify:
  - `apps/web/src/renderer/models/scooter.ts`
  - `apps/web/e2e/scooter.spec.ts`
  - `docs/open-decisions.md` (D36)
  - `AGENTS.md`

- [ ] **Step 1: The look.**
  - A `glowing(rgb(0xff, 0xf2, 0xc8), 1)` headlight voxel on the front face of the stem at z ≈ 7 (x = stem + 1, the
    middle two y).
  - A dark battery box (`rgb(0x2a, 0x2c, 0x30)`) at z = 0, from x = 3 to x = 7, under the deck.
  - Run `pnpm bench:sprites`. The sprite and doorway hashes are unchanged, and the new scooter hash is recorded in D36.

- [ ] **Step 2: Update e2e.** In `scooter.spec.ts`:
  - after 1 s of W from a standstill the rider covered over 1.5 tiles and under 6;
  - 0.5 s after releasing W they kept rolling (x still changing);
  - then run `pnpm e2e -- scooter.spec.ts`. Expected: PASS.

- [ ] **Step 3: Write the docs.** Add an "Electric" bullet group to D36:
  - the owner's choices (throttle, S brake then reverse, A/D steer, mouse turns instantly, items put away, handlebar,
    whine while moving, subtle, headlight);
  - the starting values;
  - the wall rule;
  - "no protocol change".

  Update "Left out" (coasting is now in). In AGENTS.md's scooter gotcha, add:
  - `stepRide` runs only on the rider's screen;
  - others' whine comes from their drawn positions;
  - riders' items are hidden on every screen, never sent as `held: null`.

- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck` and `pnpm lint`. Expected: PASS.

- [ ] **Step 5: Commit** "Light the scooter's headlight, test electric riding end to end and record it"
