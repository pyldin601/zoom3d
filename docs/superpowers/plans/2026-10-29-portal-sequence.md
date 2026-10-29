# Portal Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switching portals plays a shared sequence for everyone in the room:
- the first switch-on gets a countdown, darkness, the portals glowing alone, then the lamps;
- every later switch gets a 1 s blackout.

**Architecture:**
- **Shared timeline.** One pure timeline in `packages/shared` says what each sequence kind looks like at any age.
- **Server.** On Y the server starts a sequence, broadcasts it once with its `age`, flips the portals flag itself at
  the bend, and ignores Y until the sequence ends.
- **Client.** It stamps the sequence's start from `arrival − age`. Each frame it asks the timeline whether it's dark,
  and if so draws from a third, pitch-black lighting table.
- **Sounds.** The countdown and the two sounds are driven from the same timeline.

**Tech Stack:** TypeScript, Vitest, Web Audio, Node `ws` server, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-portal-sequence-design.md` (builds on D27, D28, D29)

## Global Constraints

- **Timings (ms from the press):**
  - `first_on`: countdown 0–3000 (3, 2, 1, one a second), dark from 3000, bend at 5000, lamps back at 7000, ends at
    7000.
  - `on` and `off`: dark from 0, bend at 500, lamps back at 1000, ends at 1000.
- **Countdown copy, exactly:** `Portals will enable in 3…`, then `2…`, then `1…`. Use U+2026 (…).
- **Wire:**
  - `{ type: 'portals_sequence'; kind: 'first_on' | 'on' | 'off'; age: number }` (server to client);
  - the welcome carries `sequence?: { kind, age }` while one runs;
  - client to server is unchanged, `{ type: 'portals' }`;
  - the existing `{ type: 'portals'; on }` is sent at the bend;
  - `PROTOCOL_VERSION` 4 → 5.
- **Debounce = the sequence:**
  - Y is ignored while a sequence runs in the room, and `PORTALS_FLIP_GAP_MS` is removed;
  - the move check still accepts either mode for 1000 ms after the bend.
- **Kind choice:**
  - `off` when the portals are on;
  - otherwise `first_on` if the room has never bent on, else `on`;
  - `portalsEverOn` is set at the bend, saved as an optional field of the room's snapshot entry, and the snapshot
    stays version 1;
  - a sequence running at shutdown is not saved.
- **Darkness:**
  - lamp light, bounce, ambient, fixtures and lamp reflections all go to zero, through a pitch-black table that
    window passes read too;
  - faces and other glowing things keep glowing;
  - labels, the status line and the automap are untouched;
  - unlit rooms don't darken.
- **Sync:** stamp `start = arrival − age` with no clock syncing. A sound whose moment passed more than 300 ms ago is
  skipped.
- **Sounds:**
  - "lights off" (deep, long reverb) and "power on" (lighter);
  - synthesised, unplaced (the same level everywhere) but through the room's reverb, and under voices;
  - their values come from the sketch the user approves in Task 1.
- **With no sequence running, nothing changes:**
  - same pixels;
  - portals-off bench hashes: `bench:walls` pixel -601092469, doorway off -1246551896, crowd off 2075427884;
    `bench:sprites` 1236007431, doorway scenes off -1373330069.
- **No allocations** in the per-frame path.
- **Code style:**
  - every `if`/`else`/`for`/`while` body is braced, in Biome style;
  - `.at()` over `arr[i] as T`;
  - names over comments, and comments say only why;
  - no "you/your" in identifiers, comments or test titles (UI copy excepted);
  - 120 columns.

## Review Focus

1. **Pressing Y during a sequence is ignored, including the presser's own double press.** A press right after one
   ends starts the next. (Task 3, `presses during a sequence are ignored; one right after it ends starts the next`.)
2. **Joining in the dark lands in the dark.** A welcome during `first_on` at age 4000 gives a client that is dark at
   once, with no countdown and no lights-off sound, because that moment passed long ago. (Task 4,
   `a welcome mid-sequence starts dark and skips sounds whose moment has passed`.)
3. **A restart during `first_on` before the bend keeps the room's first switch-on.** The restored room has
   `portalsEverOn` false, so the next press is `first_on` again. (Task 3,
   `a sequence is not saved, and a room restored before its bend is still first_on`.)
4. **Portals flipping at the bend with the lights out.** The portal glow appears in the dark while the main and window
   passes stay black. (Task 5, `in the dark both the main pass and the windows read the black table`.)
5. **The last person leaving mid-sequence closes the room cleanly,** and no bend is broadcast to an empty room. (Task 3,
   `a room closed mid-sequence drops its sequence`.)

---

### Task 1: Sound sketch with the user (controller, not a subagent)

The controller builds a throwaway sketch page with the two sounds. It has sliders for pitch, length and reverb, and
"Play first switch-on" / "Play blackout" buttons that also run the countdown and darkness timeline on a black panel.
It is published as an artifact. The user tunes it by ear and approves it; until then later tasks don't start.

- [ ] **Step 1:** Build the sketch in the session scratchpad and publish it.
- [ ] **Step 2:** Tune it with the user until they approve.
- [ ] **Step 3:** Write the approved recipe (nodes, frequencies, envelopes, levels, reverb send) to
  `docs/superpowers/specs/2026-10-29-portal-sequence-design.md` §2.3 as a "Recipe" sub-list. Commit
  `git commit -m "Record the portal switch sounds' recipe"`.

### Task 2: The shared timeline and the protocol

**Files:**
- Create: `packages/shared/src/portals/sequence.ts` and `packages/shared/src/portals/sequence.test.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Modify: `packages/shared/src/protocol/protocol.ts` and its test (the message, the welcome field, the validators,
  version 5)

**Interfaces:**
- Produces:
  - `type SequenceKind = 'first_on' | 'on' | 'off'`.
  - `interface SequenceTimes { darkAtMs: number; bendAtMs: number; lightsAtMs: number; endMs: number }`.
  - `sequenceTimes(kind: SequenceKind): SequenceTimes`, using the values in Global Constraints.
  - `sequenceAt(kind: SequenceKind, ageMs: number): { countdown: 3 | 2 | 1 | null; dark: boolean; ended: boolean }`.
    It returns a reused object.
  - `countdownText(n: 3 | 2 | 1): string`, returning the exact copy.
  - The protocol's `ServerMessage` gains `{ type: 'portals_sequence'; kind: SequenceKind; age: number }`.
  - `welcome.sequence?: { kind: SequenceKind; age: number }`.

- [ ] **Step 1: Write the failing tests.**
  - `sequenceAt('first_on', t)`:
    - at 0 → countdown 3, not dark;
    - at 1999 → 2;
    - at 2999 → 1;
    - at 3000 → dark, no countdown;
    - at 6999 → dark;
    - at 7000 → not dark, ended.
  - `sequenceAt('on', 0)` and `('off', 999)` → dark; `('on', 1000)` → ended.
  - `sequenceTimes('first_on').bendAtMs === 5000` and `('off').bendAtMs === 500`.
  - `countdownText(3) === 'Portals will enable in 3…'`.
  - Protocol:
    - a valid `portals_sequence` parses;
    - an unknown kind or a negative or non-finite age is rejected;
    - a welcome with and without `sequence` parses;
    - `PROTOCOL_VERSION === 5`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/shared exec vitest run src/portals/sequence.test.ts src/protocol`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** The countdown number is `3 − floor(age / 1000)` within the countdown.
- [ ] **Step 4: Run** the tests again (PASS), then `pnpm typecheck`. The client and server may fail to typecheck until
  Tasks 3 and 4. If so, make them compile with the smallest stub, such as ignoring the new message, and say so.
- [ ] **Step 5: Commit** `git commit -m "Add the portal sequence timeline and its messages (protocol 5)"`

### Task 3: The server runs sequences

**Files:**
- Modify: `apps/server/src/lobby.ts` (`portals`, `stepWorld`, the welcome, `snapshot`/`restore`, room close) and
  `apps/server/src/lobby.test.ts`

**Interfaces:**
- Consumes: `sequenceTimes` and `SequenceKind` (Task 2).
- Produces:
  - `portals(conn)` starts a sequence and broadcasts `portals_sequence` with age 0, or does nothing while one runs.
  - `stepWorld` fires the bend when its time has come. The bend:
    - flips `portalModes`;
    - sets its `flippedAt`, so the move-check grace still works;
    - sets `portalsEverOn` when turning on;
    - broadcasts `{ type: 'portals', on }`.
  - `stepWorld` drops the sequence at `endMs`.
  - The welcome sends `sequence: { kind, age }` while one runs.
  - The snapshot room entry gains `portalsEverOn?: true`.

- [ ] **Step 1: Write the failing tests** with the lobby's fake clock:
  - `the first press in a room starts first_on, and the bend at 5 s turns portals on for everyone`;
  - `a later press starts on, and a press with portals on starts off, each bending at 500 ms`;
  - `presses during a sequence are ignored; one right after it ends starts the next`;
  - `a joiner mid-sequence gets the sequence and its age in the welcome`;
  - `a sequence is not saved, and a room restored before its bend is still first_on`;
  - `portalsEverOn survives a snapshot and restore`;
  - `a room closed mid-sequence drops its sequence`;
  - `the move check accepts either mode for a second after the bend`. Adapt the existing grace test.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/server exec vitest run src/lobby.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Keep the per-room sequence (`{ kind, startedAt, bent }`) in a map next to `portalModes`.
  - Remove `PORTALS_FLIP_GAP_MS`.
  - Check the bend and the end on every `stepWorld`. The 66 ms tick is fine: the bend happens in the dark.
- [ ] **Step 4: Run** the server tests, then `pnpm test` and `pnpm typecheck`.
- [ ] **Step 5: Commit** `git commit -m "Run portal switches as timed sequences on the server"`

### Task 4: The client follows the sequence

**Files:**
- Modify: `apps/web/src/net/session.ts` and its test
- Create: `apps/web/src/game/portal-sequence.ts` and its test (the client's view of the running sequence)

**Interfaces:**
- Consumes: `sequenceAt`, `sequenceTimes` and `SequenceKind` (Task 2).
- Produces:
  - `Session.sequence: { kind: SequenceKind; startedAt: number } | null`, stamped `performance.now() − age` when a
    `portals_sequence` or a welcome with `sequence` arrives.
  - `SessionListener.sequenceStarted?(kind)`.
  - `createPortalSequence(): PortalSequence`, with:
    - `update(seq: { kind; startedAt } | null, nowMs: number): void`;
    - `readonly dark: boolean`;
    - `readonly countdown: 3 | 2 | 1 | null`;
    - `takeCues(out: { lightsOff: boolean; powerOn: boolean }): void`, which reports cues whose moment arrived since
      the last update and skips any more than 300 ms late.

- [ ] **Step 1: Write the failing tests:**
  - the session stamps `startedAt = arrival − age`, from a message and from a welcome;
  - `a welcome mid-sequence starts dark and skips sounds whose moment has passed`: `first_on` at age 4000 → `dark`
    true, `countdown` null, and no `lightsOff` cue;
  - a live `first_on` reports `lightsOff` once at 3000 and `powerOn` once at 7000;
  - `on` reports both cues;
  - a hidden-tab jump of 2 s past the cue skips it;
  - after the end, `dark` is false and there are no cues.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** The update must allocate nothing.
- [ ] **Step 4: Run** them (PASS), then `pnpm test` and `pnpm typecheck`.
- [ ] **Step 5: Commit** `git commit -m "Follow the room's portal sequence on the client"`

### Task 5: Darkness

**Files:**
- Modify: `apps/web/src/renderer/room-lighting.ts` (`createRoomLighting`), `apps/web/src/game/room.ts`,
  `apps/web/src/game/room-loop.ts` (`describeScene`), and the renderer if faces need exempting from lamp shading
- Test: `apps/web/src/renderer/room-lighting.test.ts`, plus a renderer test for the faces

**Interfaces:**
- Consumes: `PortalSequence.dark` (Task 4).
- Produces:
  - `createRoomLighting(...).lighting(portalsOn: boolean, dark: boolean)`. The dark table is baked once with the
    others: no lamps, ambient 0, no bounce, so every floor, ceiling and wall cell is black. Its `portals` and
    `portalGlowSeen` match the portals-on table's, so portal glows keep their shadows in the dark.
  - `Room.lighting(dark: boolean)`.
  - `describeScene` passes the sequence's `dark`.

- [ ] **Step 1: Write the failing tests:**
  - the dark table's floor, ceiling and wall cells are all black, and it lists no lamps;
  - `lighting(true, true)` keeps the portal glow shadow table;
  - `lighting(x, false)` is unchanged from today, as the same objects;
  - an unlit room gives null for every combination;
  - `in the dark both the main pass and the windows read the black table`: render a portals-on frame through a window
    with the dark table, and assert a window pixel away from the rim and the spill is black apart from the shimmer;
  - a face disc keeps its brightness in the dark: compare a disc pixel lit and dark.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** If faces are shaded by lamp light today, exempt them when the table is the dark one.
  Check how `sprites.ts` lights discs.
- [ ] **Step 4: Run** them (PASS), then `pnpm test`, `pnpm typecheck` and both benches. Portals-off hashes must
  hold.
- [ ] **Step 5: Commit** `git commit -m "Black out the room while a portal sequence is dark"`

### Task 6: Countdown and sounds

**Files:**
- Create: `apps/web/src/ui/portal-countdown.ts` (and test), `apps/web/src/audio/portal-switch-sound.ts` (and test)
- Modify: `apps/web/src/audio/engine.ts`, `apps/web/src/game/room-loop.ts`, `apps/web/index.html` (CSS for the
  countdown, next to `.portal-notice`)

**Interfaces:**
- Consumes: `PortalSequence` (Task 4), `countdownText` (Task 2), and the recipe in spec §2.3 (Task 1).
- Produces:
  - `AudioEngine.playUnplaced(node: AudioNode, send: number): void`. It connects `node` to the output, plus a send of
    `send` into the shared reverb, with no panner and no distance.
  - `playLightsOff(ctx, engine)` and `playPowerOn(ctx, engine)`, built from the recipe, each stopping and
    disconnecting its nodes when done.
  - `showCountdown(ui: HTMLElement, n: 3 | 2 | 1 | null): void`. It shows or updates one centred element, and removes
    it on null.
  - The room loop each frame:
    - calls `sequence.update(session.sequence, now)`;
    - calls `showCountdown(ui, sequence.countdown)`;
    - plays the cues from `takeCues`;
    - does the same on the hidden tick, but skips sounds while hidden.

- [ ] **Step 1: Write the failing tests:**
  - the countdown shows the exact copy for 3, 2 and 1, keeps one element, and removes it on null;
  - `playUnplaced` connects to the output and the reverb and adds no panner (fake context, as `engine.test.ts` does);
  - each sound builds the recipe's nodes and stops them after its length.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, then run `pnpm test`, `pnpm typecheck` and `pnpm lint`.
- [ ] **Step 4: Extend `apps/web/e2e/portals.spec.ts`:**
  - after tab A presses Y in a fresh room, tab B shows the countdown text within 1 s, and is dark at about 3.5 s;
  - expose `__game.sequenceDark()` (dev only) for this;
  - tab B's portals are on after about 5.5 s.

  Run `pnpm --filter @zoom3d/web exec playwright test e2e/portals.spec.ts`.
- [ ] **Step 5: Commit** `git commit -m "Count down and sound the portal switch for everyone"`

### Task 7: Record

**Files:** `docs/open-decisions.md` (D30), `AGENTS.md`

- [ ] **Step 1: Write D30** after D29, in its form. It covers:
  - the sequences and timings, and who chose them;
  - the debounce aligned with the sequence;
  - one message with an age, and no clock syncing, as the user accepted;
  - the bend on the server;
  - the black table, with dark windows (the user's choice);
  - `portalsEverOn` set at the bend, and sequences not saved;
  - the sounds' recipe, pointing to the spec;
  - protocol 5;
  - the bench results.
- [ ] **Step 2: Add a sentence to the Portals gotcha in `AGENTS.md`:** "Y starts a timed sequence (D30); the server
  bends the space at its `bendAtMs`, and anything that should go dark reads the room's dark table, never a dimming
  factor."
- [ ] **Step 3: Run** `pnpm lint`. Then commit `git commit -m "Record the portal sequence (D30)"`.
