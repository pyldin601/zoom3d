# Ball Rewind and Bodies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kicks land where the kicker saw the ball, and the client's ball collides with other people.

**Architecture:** The client adds to each kick which ball state it saw. The server keeps a short ring of ball states, rewinds to that moment, kicks there and re-simulates to now. Separately, the client's `step` takes other people's bodies, built each frame from their newest received poses.

**Tech Stack:** TypeScript, vitest, shared physics in `packages/shared`.

**Spec:** `docs/superpowers/specs/2026-11-02-ball-rewind-bodies-design.md`

## Global Constraints

- `KICK_REWIND_MS = 300`. Never rewind past the room's last accepted kick, or later than now.
- `kick` fields `seen` and `aheadMs` stay optional, with no `PROTOCOL_VERSION` bump. A kick without them gets no rewind.
- `KICK_SEEN_LATE_S` is removed; reach allowance is `KICK_SLACK_TILES` alone. Gap check and `kick_refused` are unchanged.
- `portals: null` keeps its results. Contacts go through `apparentPosition` when portals are on.
- No per-frame allocations on the client. The server's history is a fixed ring per ball.
- Bots and the vacuum are not client-side bodies. Only local touches extend the hold.
- Style: `docs/code-style.md`, third-person names, comments only say why, braced blocks, `.at()`.

## Review Focus

- A kick whose `seen` predates a reconnect or server restart: treated as the oldest allowed moment, or no rewind if the history is empty.
- A bad `aheadMs` (negative, huge, non-number): parser drops the fields or the clamp bounds it; the kick is never lost for that reason.
- Two people kicking within the window, the later arrival aimed earlier: the first kick's effect survives.
- A ball crossing a portal during the re-simulation: comes out where the portals carry it.
- A peer in reconnect grace: the client can't tell them from someone standing still, so the ball may bounce off them locally. The server's state must then glide it back without a snap.

---

### Task 1: The kick says what it saw

**Files:**
- Modify: `packages/shared/src/protocol/protocol.ts`, `protocol.test.ts`
- Modify: `apps/web/src/game/ball-prediction.ts`, `ball-prediction.test.ts`
- Modify: `apps/web/src/net/session.ts`, `session.test.ts`, `apps/web/src/game/room.ts`

**Interfaces:**
- Produces: `KickMessage = { type: 'kick'; angle: number; k: number; seen?: number; aheadMs?: number }`; `BallPrediction.aim(now: number): KickAim | null`; `KickAim = { seen: number; aheadMs: number }`, exported from shared; `session.sendKick(angle, k, aim: KickAim | null)`.

- [ ] **Step 1: Write failing tests**
  - Protocol: a kick with both fields round-trips; `seen` without `aheadMs`, negative `aheadMs` or non-finite `aheadMs` parses to a kick with neither field.
  - Prediction `aim`: null after `reset`; after `server(state(…, { seq: 7 }), 'me', 100)`, `aim(130)` is `{ seen: 7, aheadMs: 90 }` (60 ms `LATENCY_S` + 30); a new `reset` makes it null again.
  - Session: `sendKick(0, 1, { seen: 7, aheadMs: 90 })` sends both fields, and with `null` sends neither.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/shared/src/protocol apps/web/src/game/ball-prediction.test.ts apps/web/src/net/session.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Prediction stores the last state's `seq` and arrival time in `server()`; `room.ts` passes `ball.aim(now)` to `sendKick`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** "Say which ball state a kick was aimed at".

### Task 2: The server rewinds a kick

**Files:**
- Create: `apps/server/src/objects/ball/ball-history.ts`, `ball-history.test.ts`
- Modify: `apps/server/src/lobby.ts`, `apps/server/src/objects/ball/ball-lobby.test.ts`
- Modify: `docs/superpowers/specs/2026-10-23-ball-design.md` (§3.2), `docs/open-decisions.md` (D26), `AGENTS.md` (ball gotcha)

**Interfaces:**
- Consumes: `KickMessage.seen`, `aheadMs` from Task 1.
- Produces: `createBallHistory(): BallHistory` with `record(atMs, seq: number | null, ball)` (null for a kick's entry, so a `seen` never names it), `timeOf(seq): number | null`, `latestAtOrBefore(atMs): BallEntry | null`; `aimedMoment(history, aim: KickAim | null, nowMs, lastKickAtMs): number`. Ring capacity 12: a state every 66 ms over 300 ms, plus kicks.

- [ ] **Step 1: Write failing history tests**
  - `aimedMoment`: `timeOf(seen) + aheadMs` inside the window is returned as is; clamped to `now - 300`, to `now`, and to `lastKickAtMs`; unknown `seen` gives `now - 300`; null aim gives `now`.
  - The ring overwrites its oldest entry, and `latestAtOrBefore` returns null before the first entry.
- [ ] **Step 2: Write failing lobby tests**
  - A rolling ball out of reach now, but in reach at the aimed moment, is kicked. The next state's position is where a kick at that moment would have rolled to, within 0.05 tiles.
  - The same kick with no fields is refused, and the ball is untouched (no rewind, no speed allowance).
  - A kick out of reach at the aimed moment is refused, and the ball is untouched.
  - Two kicks: the second aimed before the first keeps the first's effect (rewinds only to the first's entry).
  - After `restore`, an empty history means no rewind and no throw.
  - With portals on, a re-simulation crossing a portal ends where `stepBall` with the portals would.
  - Update PR 131's rolling-ball reach test, which relies on the removed speed allowance.
- [ ] **Step 3: Run** `pnpm exec vitest run apps/server/src/objects/ball`. Expected: the new tests FAIL.
- [ ] **Step 4: Implement.** Keep a history per ball next to `balls`, deleted in `closeRoom`. Record in `stepBalls` beside each `object_state`, and record a null-seq entry when a kick lands. Extract `ballBodies(...)` from `stepBalls` for the re-simulation. In `kick`: rest check, then copy the entry to a scratch ball, advance to the moment, check reach, kick, advance to now in one `stepBall` (it substeps, and takes up to 1 s), then assign to the real ball. With no history or a null aim, this is today's path on the real ball.
- [ ] **Step 5: Run** the same command, then `pnpm bench:tick`. Expected: PASS, and tick time about unchanged.
- [ ] **Step 6: Update the docs listed above.**
- [ ] **Step 7: Commit** "Land a kick where the kicker saw the ball".

### Task 3: Other people's bodies on the client

**Files:**
- Create: `apps/web/src/game/ball-bodies.ts`, `ball-bodies.test.ts`
- Modify: `apps/web/src/game/ball-prediction.ts`, `ball-prediction.test.ts`, `apps/web/src/game/room-loop.ts`
- Modify: `packages/shared/src/protocol/protocol.ts`, `protocol.test.ts`, `apps/server/src/lobby.ts` (`peerInfo`), `ball-lobby.test.ts`
- Modify: `docs/superpowers/specs/2026-10-23-ball-design.md` (§3.3), `docs/open-decisions.md` (D26), `AGENTS.md` (ball gotcha)

**Interfaces:**
- Produces: `PeerInfo.bot?: true`, since clients can't tell bots from people today (additive, no version bump); `createOtherBodies(): (peers: ReadonlyMap<string, RemotePeer>, ball: Point, now: number) => readonly BallBody[]`, reusing one pooled array; `BallPrediction.step(dt, now, self, others: readonly BallBody[])`.

- [ ] **Step 1: Write failing tests**
  - Protocol and lobby: `peerInfo` of a bot says `bot: true`, a person's has no such field, and it survives `parsePeerInfo`.
  - Bodies: uses `buffer.latest()`, not a delayed sample; velocity comes from the last two poses; velocity is 0 when the newest pose is older than 200 ms (`MOVING_POSE_MS`'s client twin); bots are skipped; peers more than 3 tiles from the ball are skipped; two calls return the same array.
  - Prediction: a ball rolling at another's still body bounces back; another's body touching the ball doesn't extend the hold, so a server state still eases it; the bounce returns the `'bounce'` event; a phantom bounce off a body glides back to the server's ball with no frame move over 0.5 tiles.
  - Portals: a body through a doorway collides at its apparent position, reusing the two-doorway helper from the existing portal test.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/shared/src/protocol apps/server/src/objects/ball apps/web/src/game/ball-bodies.test.ts apps/web/src/game/ball-prediction.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Pool the seen-from-ball copies inside the prediction, growing only when there are more bodies than before. Pass the bodies only to the local ball's `stepBall`; the server copy stays on `NO_BODIES`. `room-loop.ts` calls `createOtherBodies` once and passes its result to `step`.
- [ ] **Step 4: Run** the same command, then `pnpm typecheck && pnpm lint && pnpm test`. Expected: PASS.
- [ ] **Step 5: Update the docs listed above.**
- [ ] **Step 6: Commit** "Let the predicted ball feel other people".

### Task 4: Measure

**Files:** throwaway script in the scratchpad (`sim/prod.ts`), not committed.

- [ ] **Step 1:** Give the script's players the bodies and kick fields, and an optional added one-way delay of 25 ms each way.
- [ ] **Step 2:** Bodies alone: run 300 s against prod with the kick fields off. Baseline: 709 kicks, 3 jumps over 0.6 tiles, 1 over 1.5, 28 refused.
- [ ] **Step 3:** Rewind: `preview_start zoom3d`, then run 300 s against the local server, once without the new code's fields and once with them. Local runs compare with each other only.
- [ ] **Step 4:** Run `pnpm e2e`. Expected: all pass; re-run any failure alone before calling it flaky.
- [ ] **Step 5:** Record the numbers in D26. If either part makes things worse, say so and stop rather than tuning. Commit "Record the ball rewind and bodies results".
- [ ] **Step 6:** One fresh review of the whole branch on the most capable model, then report rulings to the owner.
