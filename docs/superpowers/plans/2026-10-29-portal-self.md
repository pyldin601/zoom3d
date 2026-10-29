# See Yourself Through Portals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With portals on, the local player sees their own avatar (face disc, held item, bob, name label) through any
window that looks back at where they stand, and never in the direct view.

**Architecture:**
- **Drawing.** `frame.ts` hands each window level `scene.people`. Window levels get that list plus one pooled own
  sprite (`RoomScene.self`); the main pass still draws only `scene.people`.
- **The label.** It is drawn at the own position's image through a portal, the nearest seen one. It reuses the
  apparent-position search, with the straight-line candidate excluded, since a person never labels themselves in the
  direct view.

**Tech Stack:** TypeScript, Vitest, Biome, esbuild benches.

**Spec:** `docs/superpowers/specs/2026-10-29-portal-self-design.md`

## Global Constraints

- **The main pass never draws the own avatar or its label.** Only window passes and labels seen through a window do.
- **Portals off, or no window on screen: nothing changes.**
  - Same pixels.
  - `bench:walls`: pixel -601092469, doorway off -1246551896, crowd off 2075427884.
  - `bench:sprites`: 1236007431, doorway scenes off -1373330069.
- **Dynamic subscription is untouched:** the `seen` facts never count the local player (its key isn't a peer).
- **No per-frame allocations;** the own sprite and label are pooled.
- **Code style:**
  - Biome style, with braced bodies;
  - `.at()`;
  - names over comments, and comments say only why;
  - no "you/your" in identifiers, comments or test titles (use "own" / "local player");
  - 120 columns.

## Review Focus

1. **The window's near limit.** In a window pass, the own avatar at the eye's real spot is drawn only beyond the
   plane; it never appears pressed against the camera. (Task 1, `the own avatar shows only beyond the window's
   plane`.)
2. **Portals off means no own avatar anywhere,** including the label. (Task 1, `with portals off the frame is the same
   as today`; Task 2, `no own label with portals off`.)
3. **`seen` facts never get the local player's key.** (Task 1, `seen never counts the local player`.)
4. **A window inside a window** shows the own avatar too. (Task 1, run at window level 2.)
5. **Hidden while the camera is off:** the disc falls back to the ring colour, as others see it. (Task 1, covered by
   building the sprite from the same face and colour sources the own glow uses.)

---

### Task 1: The own avatar in window passes

**Files:**
- Modify:
  - `apps/web/src/renderer/frame.ts` (`RoomScene`, `drawWindow`);
  - `apps/web/src/game/room-loop.ts` (`describeScene` fills `scene.self`);
  - the place that builds remote sprites (`game/remote-world.ts`), if a shared builder helps;
  - benches and helpers that build a `RoomScene` (set `self: null`).
- Test: `apps/web/src/renderer/frame.test.ts`

**Interfaces:**
- Produces:
  - `RoomScene.self: Sprite | null`, the local player's sprite. Its fields:
    - `key`: a fixed key that is no peer id, such as `'self'`;
    - its pose: x, y, bob, itemBob;
    - the own face texture, or null for a flat disc;
    - the own ring colour;
    - speaking: the local mic level, or 0 if there is no cheap source;
    - the held item.
    It is null while not in a room.
  - Window levels draw `people` plus `self`, through one pooled array per level, rebuilt only when `scene.people`
    changes length or identity. The main pass draws `scene.people` only.

- [ ] **Step 1: Write the failing tests** in `frame.test.ts`, with the existing portal fixtures:
  - `the own avatar shows through a window that looks back at the eye`. Set up a portal whose far side sees the eye's
    position. A disc pixel of `self`'s colour appears inside the window's columns.
  - `the own avatar shows only beyond the window's plane`. Nothing of `self` is drawn nearer than the plane's depth.
  - `the main pass never draws the own avatar`. With `self` set and no window on screen, the frame equals one with
    `self: null`.
  - `with portals off the frame is the same as today`. Use `portals: null` with `self` set.
  - `seen never counts the local player`. After a frame showing `self` through a window, `seen.has('self')` is false.
  - The first test repeated at window level 2.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/renderer/frame.test.ts`. Expected: the new tests
  FAIL.
- [ ] **Step 3: Implement.**
  - Build `scene.self` in `describeScene` from `localPlayer` (pose, bob, held item, own face and colour as the own
    glow gets them) with no allocation.
  - Window levels draw `people ∪ self`. Make sure the `seen`/facts writing skips the own key.
- [ ] **Step 4: Run** the test file (PASS), then `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm bench:walls` and
  `pnpm bench:sprites`. Portals-off hashes must hold. Report the portals-on hashes.
- [ ] **Step 5: Commit** `git commit -m "Show the local player's own avatar through portal windows"`

### Task 2: The own name label through a window, and the record

**Files:**
- Modify:
  - `apps/web/src/game/apparent-world.ts`, or wherever labels get their apparent positions;
  - `apps/web/src/game/room-loop.ts`;
  - `docs/open-decisions.md` (a line under D27's gaps);
  - `AGENTS.md`, only if the Portals gotcha needs it.
- Test: the matching `*.test.ts`

**Interfaces:**
- Consumes: `apparentPosition` (packages/shared), Task 1's `RoomScene.self`.
- Produces: the own label is added to `scene.labels` at the own position's nearest seen image through one or two
  portals, never at the real position. There is no own label with portals off, or when no image is seen.

- [ ] **Step 1: Write the failing tests:**
  - `the own label sits at the own position's image through the portal that shows it`;
  - `no own label with portals off`;
  - `no own label when no portal shows the own position`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse the apparent-position search, but skip its straight-line candidate. Either add an
  option to `apparentPosition`, or a small wrapper that runs the image candidates only. Pick whichever keeps
  `apparentPosition`'s existing results identical, and say which.
- [ ] **Step 4: Run** them (PASS), then `pnpm test`, `pnpm typecheck` and `pnpm lint`.
- [ ] **Step 5:** Under D27's known gaps in `docs/open-decisions.md`, change "A player never sees themselves through a
  portal loop" to say the gap was closed on 2026-10-29, with a link to the spec. Then commit
  `git commit -m "Label the local player through portal windows, and close the gap in D27"`.
