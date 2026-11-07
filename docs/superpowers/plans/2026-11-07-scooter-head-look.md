# Scooter Head Look Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While riding, the mouse and touch drags turn only the head, up to ±90° from the scooter's heading, and the
head stays where it is left. Only the steering keys turn the scooter.

**Architecture:** `LocalPlayer` keeps a `head` angle beside `pose`. `pose.angle` stays the scooter's heading (what the
server and others get). A pooled `eye()` pose (heading + head) is what the camera, the listener, the apparent world,
labels, subscription, hums and kicks use.

**Tech Stack:** TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-electric-scooter-riding-design.md` §7

## Global Constraints

- `HEAD_LIMIT = Math.PI / 2`. No easing back. Stepping off does `pose.angle += head; head = 0`; stepping on sets
  `head = 0`.
- On foot nothing changes: the mouse turns `pose.angle` and `eye()` equals the pose.
- No allocations per frame: `eye()` returns one pooled object.

## Review Focus

1. **A server correction** moves `pose`: `eye()` follows on the next read, with the head kept. Test in Task 1.
2. **Crossing a portal while riding** with the head turned: the heading is carried, the head kept. Test in Task 1.
3. **Reconnecting while riding:** `riding` flips false then true, so the body turns to the look and the head resets.
   No test needed, since the setter tests cover it.
4. **The hidden tab:** no walking, so the head can't change.
5. **Kicking while looking sideways:** the kick goes where the head looks. Test in Task 2 (via `kickAngle`).

---

### Task 1: The head on `LocalPlayer`

**Files:** Modify `apps/web/src/game/local-player.ts` (+ test).

**Interfaces:**
- Produces:
  - `LocalPlayer.head: number` (read-only; radians, + is right);
  - `LocalPlayer.eye(): PlayerState` (pooled: the pose's x, y and `angle + head`);
  - `FirstPerson.head: number` (set by `firstPerson()`).
- In `walk`, riding: `head = clamp(head + turnRad, ±HEAD_LIMIT)` and `pose.angle` gets no mouse turn. On foot it works
  as before.

- [ ] **Step 1: Write the failing tests** in `local-player.test.ts`:
  - **`riding, the mouse turns the head and not the scooter`:** `walk(MAP, STILL, 0.5, 0.016)` leaves `pose.angle`
    unchanged; `head` is 0.5 and `eye().angle` is `pose.angle + 0.5`.
  - **`the head stops at 90° each way`:** turns of 2 give a `head` of π/2; turns of −5 give −π/2.
  - **`the head stays where it is left`:** after a turn of 0.4 and then 30 still walks, `head` is 0.4.
  - **`stepping off faces where the head looked`:** riding with angle 1 and head 0.5, then `riding = false`: angle 1.5
    and head 0.
  - **`stepping on starts with the head straight`.**
  - **`on foot the mouse turns the body, and the eye is the pose`.**
  - **`the eye follows a correction`** (Review Focus 1): mutate `pose.x` directly; `eye().x` matches.
  - **`a portal carries the heading and keeps the head`** (Review Focus 2): use `twoDoorways` as in the existing portal
    walk test, riding at speed 4 with head 0.3 through doorway A; afterwards `head` is 0.3 and `sin(pose.angle) < -0.99`.
  - **`firstPerson carries the head`.**
- [ ] **Step 2:** Run `pnpm --filter @zoom3d/web exec vitest run src/game/local-player.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `pnpm test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit "Turn only the head with the mouse while riding".

### Task 2: Everything that looks uses the eye; the handlebar follows the scooter

**Files:**
- Modify:
  - `apps/web/src/game/room-loop.ts`
  - `apps/web/src/game/room.ts` (kick)
  - `apps/web/src/game/game.ts`
  - `apps/web/src/renderer/own-handlebar.ts` (+ test)
  - `apps/web/src/renderer/frame.ts`
- Also: `docs/open-decisions.md` (D36).

**Interfaces:**
- `renderOwnHandlebar(fb, steer, head)`: the whole bar shifts by `−tan(head) / tan(fb.fov / 2) × w / 2`. At
  `|head| ≥ fov / 2 + 0.6` it isn't drawn at all, since it would be fully off screen.
- `JoinOptions.aim: () => number` gives the kick's angle (`localPlayer.eye().angle`).

- [ ] **Step 1: Write the failing tests** in `own-handlebar.test.ts`:
  - **`looking right slides the bar left`:** with head 0.3, the bar's right edge is left of its right edge at head 0.
  - **`at 90° the bar is out of view`:** with head π/2, nothing is drawn.
- [ ] **Step 2:** Run `pnpm --filter @zoom3d/web exec vitest run src/renderer/own-handlebar.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it**:
  - the handlebar shift;
  - `drawFirstPerson` passes `hands.head`;
  - `room-loop` uses `localPlayer.eye()` for `scene.eye`, `placeOwnLabel`, `apparentWorld.update`,
    `room.audio.update`, the subscription's `player`, `hums.sync` and the hidden ticker's equivalents;
  - `world.sample` and `ride.inReach` keep `pose`, since they use position only;
  - `room.kick` uses `opts.aim()` for the angle sent and predicted.
- [ ] **Step 4:** Run `pnpm test`, `pnpm typecheck` and `pnpm lint`. Expected: PASS.
- [ ] **Step 5: Update D36:** replace "the mouse turns it instantly (owner, over capping the mouse and over a separate
  look direction)" with "the mouse turns only the head, up to ±90°, and it stays where it is left (owner, 2026-11-07,
  replacing an instant turn)". Then commit "Look with the head while riding: camera, sound and kicks follow it".
