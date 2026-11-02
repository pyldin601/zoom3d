# Living Ball Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the room's ball a puppy's personality (a state machine and FM sounds) while a kick still always wins.

**Architecture:** A pure state machine in `packages/shared/src/objects/ball/mind.ts` runs on the server only, before `stepBall`, setting the ball's velocity when it isn't moving faster than its own speed. The mood and sounds travel on `object_state`. Clients keep their position prediction and only draw a small shake and play the sounds.

**Tech Stack:** TypeScript, vitest, Web Audio, the existing `Lobby` tick and `ball-prediction`.

**Spec:** `docs/superpowers/specs/2026-11-02-living-ball-design.md`

**Branch:** `feat/living-ball`, from `fix/ball-push-hold` (PR 132 isn't merged). The untracked `2026-11-02-ball-rewind-bodies` drafts and `.claude/` stay out of every commit.

## Global Constraints

- Own speed 1 tile/s; wake 10 s after the last kick; sees people within 6 tiles by `hasLineOfSight`, ignoring portals.
- Stopping distance: touching + 0.25 tiles. Leaves `wiggling` beyond touching + 1 tile. Touching is `PLAYER_RADIUS + BALL_RADIUS`.
- A chase lasts 6 s in total across `approaching` and `following`, restarting only on reaching the person. Giving up ignores that person for 15 s, or until they are within 2 tiles.
- `scared` lasts 6 s. Sound cooldown 3 s, shared, yelp exempt. Giggle on the first push after 5 s with no push.
- One to five sounds per emotion, never the same one twice in a row.
- `stepBall`, `kickBall` and their constants keep their behaviour and existing results. No per-frame allocations in the client.
- No `PROTOCOL_VERSION` bump: `parseServerMessage` and `parseObjectInfo` rebuild messages field by field, so older tabs drop the new fields.
- Style: `docs/code-style.md`; no "you/your" in identifiers, comments or test titles; `.at()` over `arr[i] as T`; braced bodies; `pnpm exec biome check --write .`.

## Review Focus

- A kick on a wiggling or wandering ball: the ball must move exactly as a kicked ball with no mind does. Pinned in Task 3.
- The chosen person disconnects or leaves mid-chase: the ball finishes the chase at the last seen spot and gives up, with no crash. Pinned in Task 2.
- A wander target it can't reach (a person or wall in the way): it must not push forever. Pinned in Task 2.
- A second person nearer than its chosen person: it stays with the first. Pinned in Task 2.
- A client reconnecting while the ball is awake: the welcome's mood replaces any held kick mood. Pinned in Task 4.

---

### Task 1: Wire fields and what the physics reports

**Files:**
- Modify: `packages/shared/src/protocol/protocol.ts`, `packages/shared/src/protocol/protocol.test.ts`
- Modify: `packages/shared/src/objects/ball/ball.ts`, `packages/shared/src/objects/ball/ball.test.ts`

**Interfaces:**
- Produces, in `protocol.ts`, next to `ObjectEvent`:
  - `type BallMood = 'asleep' | 'wandering' | 'approaching' | 'wiggling' | 'following' | 'scared'`
  - `type BallCry = 'yawn' | 'happy' | 'relieved' | 'sad' | 'yelp' | 'giggle' | 'whimper' | 'yip' | 'startled'`
  - `ObjectInfo.mood?: BallMood`; `object_state` gains `mood?: BallMood`, `cry?: BallCry`, `cryVariant?: number`.
- Produces, in `ball.ts`:
  - `interface BallTouch { pushed: boolean; knocked: boolean; crossedPortal: boolean }`
  - `stepBall(map, ball, dt, bodies, portals = null, touch: BallTouch | null = null)`: sets those fields to true when they happen and never clears them; the caller does.

- [ ] **Step 1: Create the branch and commit the spec**

```bash
git switch -c feat/living-ball
git add docs/superpowers/specs/2026-11-02-living-ball-design.md docs/superpowers/plans/2026-11-02-living-ball.md
git commit -m "Design the living ball"
```

- [ ] **Step 2: Write the failing tests**

In `protocol.test.ts`:
- `object_state` with `mood: 'scared', cry: 'whimper', cryVariant: 2` round-trips.
- An unknown mood or cry is dropped, with the rest of the message kept.
- A `cry` with no valid `cryVariant`, or a `cryVariant` with no `cry`, drops both.
- `welcome.objects` keeps a ball's `mood`.

In `ball.test.ts`, with a `BallTouch` initialised to all false:
- A moving person walking into the ball sets `pushed`; a still person it rolls into doesn't.
- A vacuum driving into it sets `knocked`, and a person doesn't.
- With `twoDoorways`, rolling through a portal sets `crossedPortal`; rolling without crossing doesn't.
- Passing no `touch` gives the same result as passing one.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm exec vitest run packages/shared/src/protocol packages/shared/src/objects/ball`
Expected: FAIL on the new tests.

- [ ] **Step 4: Implement**

`parseObjectInfo` and the `object_state` case validate against `BALL_MOODS` and `BALL_CRIES`, the way `OBJECT_EVENTS` does. `cryVariant` uses `isSeq`. In `collide`, `pushed` is set when `body.kind === 'person'` and `bodyNormal > 0`, and `knocked` where the vacuum's `note('kick')` is. `carryBall` returns whether it carried.

- [ ] **Step 5: Run them to see them pass, then commit**

Run: `pnpm exec vitest run packages/shared/src/protocol packages/shared/src/objects/ball`
Expected: PASS.

```bash
git add packages/shared/src
git commit -m "Carry the ball's mood and report its pushes and portal crossings"
```

### Task 2: The mind and its sound table

**Files:**
- Create: `packages/shared/src/objects/ball/cries.ts`, `packages/shared/src/objects/ball/cries.test.ts`
- Create: `packages/shared/src/objects/ball/mind.ts`, `packages/shared/src/objects/ball/mind.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `BallMood`, `BallCry`, `BallTouch`, `BALL_RADIUS`, `PLAYER_RADIUS`, `hasLineOfSight`.
- Produces, in `cries.ts`:
  - `interface BallCrySound { startHz: number; endHz: number; ratio: number; depth: number; durationS: number; peak: number }`, where `ratio` is modulator/carrier frequency and `depth` the modulation index.
  - `BALL_CRIES: Record<BallCry, readonly BallCrySound[]>`
- Produces, in `mind.ts`:
  - `interface BallMind { readonly mood: BallMood; ... }`, with internal state as a tagged union on `mood`
  - `interface BallSenses { people: readonly { id: string; x: number; y: number }[]; touch: BallTouch }`
  - `interface BallCryChoice { cry: BallCry; variant: number }`
  - `createBallMind(): BallMind`, asleep with 10 s to go
  - `stepBallMind(map: GameMap, mind: BallMind, ball: Ball, dt: number, senses: BallSenses, rng: () => number): BallCryChoice | null`: only ever writes `ball.vx`/`ball.vy`
  - `kickBallMind(mind: BallMind, rng: () => number): BallCryChoice | null`: the yelp if it was awake
  - Exported constants for tests: `BALL_OWN_SPEED = 1`, `BALL_WAKE_S = 10`, `BALL_SEES_TILES = 6`, `BALL_STOP_TILES`, `BALL_CRY_COOLDOWN_S = 3`

- [ ] **Step 1: Write the failing tests for the table**

Every emotion has 1–5 sounds, each with positive `durationS`, `startHz`, `endHz`, and `peak` at most 1, and no two sounds of an emotion are identical.

- [ ] **Step 2: Write the failing tests for the mind**

Drive it with a fixed `dt` of 1/15 s on an open test map and a seeded `rng`. Named tests, each asserting `mind.mood` and any cry:

- **Sleep:** stays asleep for 9.9 s and wakes `wandering` with a yawn at 10 s; pushes don't move the timer; a kick while asleep restarts it with no cry; a kick from each of the other five states gives `asleep` and a yelp, and writes no velocity.
- **Crossings:** crossing while asleep then waking with nobody in sight gives `scared` and a whimper; with someone in sight gives `wandering` and a yawn; a kick on a lost, sleeping ball keeps it lost. Awake with nobody in sight gives `scared` and a whimper; awake with someone in sight gives `approaching` and a yip; crossing while `scared` restarts its 6 s.
- **Seeing:** a person 6 tiles off in sight is seen and at 6.5 isn't; one behind a wall isn't; the nearest is chosen.
- **Stays with the first person (Review Focus):** a second person coming nearer during `approaching` and `wiggling` doesn't change its person.
- **Approach:** it reaches `wiggling` at `BALL_STOP_TILES`, and the velocity is zero there; `BALL_STOP_TILES` is above touching and within `BALL_KICK_REACH`.
- **Leaving:** `wiggling` holds at touching + 0.9 and becomes `following` at touching + 1.1, or when line of sight is lost.
- **Giving up:** a chase switching between `approaching` and `following` ends at 6 s in total with `wandering` and a sad cry, and reaching them restarts it. The person is then ignored for 15 s, seen again after that, and forgiven early at 2 tiles. A second person can be chosen straight after giving up.
- **Person gone (Review Focus):** a person dropped from `senses.people` mid-chase turns it towards their last seen spot, and it gives up on time.
- **Unreachable wander target (Review Focus):** with a target it can't reach, it picks a new one within 5 s and never keeps pushing.
- **Scared:** seeing a person gives `approaching` and relieved; 6 s alone gives `wandering`; it writes zero velocity.
- **Physics first:** with the ball faster than `BALL_OWN_SPEED`, velocity is untouched, and mood and chase, wander and scared timers don't advance, while the sleep timer and cooldown do. Steering never sets a speed above `BALL_OWN_SPEED`.
- **One-offs:** a long stream of pushes gives one giggle per calm period (5 s), not one per 3 s; none while asleep. `knocked` gives startled while awake and never sleeps it.
- **Sound limits:** a transition within 3 s of another cry happens silently; the yelp ignores the cooldown; over many rolls an emotion with several sounds never repeats a variant in a row, and one with a single sound gives 0.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm exec vitest run packages/shared/src/objects/ball`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `cries.ts`**

A first set, as many per emotion as sound distinct. Characters: yawn a slow fall with a soft rise; happy two quick rises; relieved a warm rising sigh; sad a slow falling note; yelp a sharp high drop; giggle a fast warble with a high `depth`; whimper a thin, wavering fall; yip a short high blip; startled a sudden jump up. The owner tunes these by ear in Task 6.

- [ ] **Step 5: Implement `mind.ts`**

Order within `stepBallMind`:
1. Count down the cooldown and time since the last push, and clear expired or forgiven ignores (a `Map<string, number>` is fine: this is server-only).
2. Handle the touch: crossing, then giggle and startled.
3. Asleep: the sleep timer only, and return.
4. If the ball is faster than `BALL_OWN_SPEED`, return.
5. Run the current state's behaviour.

Wander picks a spot at a random angle 1–3 tiles away with line of sight and gives it 5 s; with no line of sight it pauses again. Pauses are 1–4 s.

- [ ] **Step 6: Run them to see them pass, then commit**

Run: `pnpm exec vitest run packages/shared/src/objects/ball`
Expected: PASS.

```bash
git add packages/shared/src
git commit -m "Give the ball a mind: moods, senses and its cries"
```

### Task 3: The mind on the server

**Files:**
- Modify: `apps/server/src/lobby.ts`, `apps/server/src/server.ts`
- Test: `apps/server/src/objects/ball/ball-lobby.test.ts`

**Interfaces:**
- Consumes: `createBallMind`, `stepBallMind`, `kickBallMind`, `BallTouch`, `BallCryChoice`.
- Produces: `LobbyOptions.ballMind?: boolean`, off unless set; `ServerOptions.ballMind?: boolean`, `opts.ballMind ?? true`. Ball `object_state` carries `mood` with the option on; `welcome.objects` carries the ball's mood.

- [ ] **Step 1: Write the failing tests**

- With the option off, nothing changes: no `mood`, and the ball rests through 30 s with someone beside it.
- With it on, a person in sight: within 10 s + a tick the ball goes `wandering` with `cry: 'yawn'`, then heads for them.
- **A kick lands the same (Review Focus):** two lobbies with the same seed, one mind on and one off, the ball placed by hand beside the kicker. After the same kick and ticks, positions and velocities are equal for the whole roll, and the mind-on state says `asleep` and `cry: 'yelp'` in the same broadcast as the kick echo.
- A kick on a sleeping ball sends no `cry`.
- A ball resting in `wiggling` sends nothing tick after tick, but a mood change at rest does send.
- A new joiner's `welcome.objects` has the mood.
- Bots are not seen: a bots-only neighbourhood leaves it `wandering`.
- Portals: with `twoDoorways` on, a ball rolled through with nobody there comes out `scared`.
- A saved and restored ball starts `asleep`, and `LobbySnapshot` is unchanged.
- An empty room's mind doesn't step, and closing a room removes its mind.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/server/src/objects/ball`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `Lobby` keeps, per room, a `BallMind`, a `BallTouch`, and a pending cry, created in `spawnBall` and the restore path and deleted with the room.
- `kick`: on a landed kick, call `kickBallMind` and keep its cry as the pending one.
- `stepBalls`: run `stepBallMind` before `stepBall`, with connected people at their raw poses and last tick's touch, then clear the touch and pass it to `stepBall`. A pending yelp beats the tick's cry.
- Broadcast also when the mood changed or there's a cry, adding `mood`, `cry` and `cryVariant`.

- [ ] **Step 4: Run them, and the whole server suite**

Run: `pnpm exec vitest run apps/server packages/shared`
Expected: PASS.

- [ ] **Step 5: Check the tick cost**

Run: `pnpm bench:tick`
Expected: no meaningful change with 100 bots and 4 or 100 people.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src
git commit -m "Run the ball's mind on the server"
```

### Task 4: The mood on the client, and the drawn shake

**Files:**
- Modify: `apps/web/src/game/ball-prediction.ts`, `apps/web/src/game/ball-prediction.test.ts`
- Create: `apps/web/src/game/ball-shake.ts`, `apps/web/src/game/ball-shake.test.ts`
- Modify: `apps/web/src/game/remote-world.ts`, `apps/web/src/game/remote-world.test.ts`, `apps/web/src/game/room-loop.ts`

**Interfaces:**
- Consumes: `BallMood`, `ObjectInfo.mood`, `ObjectStateMessage.mood`.
- Produces:
  - `BallPrediction.mood: BallMood`, read each frame; `BallPrediction.forceMood(mood: BallMood | null): void`, a dev override
  - `ballShake(mood: BallMood, heading: number, nowMs: number, out: { x: number; y: number }): void`, allocating nothing
  - `RemoteWorld.sample(session, player, now, ball?, portals?, ballMood: BallMood = 'asleep')`

- [ ] **Step 1: Write the failing tests**

Prediction:
- A welcome's mood is taken; a missing one is `asleep`.
- A server state's mood is taken on the next step.
- A local kick makes it `asleep` immediately, and later server states saying `wiggling` are ignored until the kick is answered.
- An echo or a refusal returns to the server's mood on the next step.
- With no answer within 1 s, it returns anyway.
- **Reconnect (Review Focus):** `reset` during a held kick takes the welcome's mood.
- Position behaviour stays the same: the existing tests pass untouched.

`ballShake`: `asleep`, `wandering`, `approaching` and `following` give exactly 0; `wiggling` stays within ±0.05 tiles along the line across `heading`; `scared` stays within ±0.03 on each axis and changes quickly.

`remote-world`: the ball's pose is offset by the shake with `wiggling`, and is exactly the ball's position with `asleep`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/web/src/game`
Expected: FAIL.

- [ ] **Step 3: Implement**

The mood is recomputed in `step` and set directly in `kick`: while `unechoed !== null && now < holdUntil` it is `asleep`, otherwise the last server mood; a forced mood overrides both. `sampleObjects` adds the shake to `at` only; the roll in `room-loop.ts` keeps using the real ball, as does `ballInReach`. Wiggle about 2 Hz; tremble about 14 Hz, with different phases per axis.

- [ ] **Step 4: Run the tests and the benchmark**

Run: `pnpm exec vitest run apps/web/src/game` then `pnpm bench:sprites`
Expected: PASS; pixel hash unchanged, because the benchmark's ball is asleep.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/game
git commit -m "Shake the drawn ball with its mood, and stop on the frame of a kick"
```

### Task 5: FM sounds and the dev audition

**Files:**
- Modify: `apps/web/src/audio/ball-sound.ts`, `apps/web/src/audio/ball-sound.test.ts`
- Modify: `apps/web/src/audio/object-sounds.ts`, `apps/web/src/audio/object-sounds.test.ts`
- Modify: `apps/web/src/game/room.ts`, `apps/web/src/game/game.ts`

**Interfaces:**
- Consumes: `BALL_CRIES`, `BallCrySound`, `BallPrediction.forceMood`.
- Produces:
  - `BallSound.cry(sound: BallCrySound): void`
  - `ObjectSounds.cry(id: string, cry: BallCry, variant: number): void`
  - On `forTests`: `ballCry(cry: BallCry, variant: number): void`, `forceBallMood(mood: BallMood | null): void`

- [ ] **Step 1: Write the failing tests**

With `FakeAudioContext`:
- `cry` creates a modulator oscillator at `startHz × ratio`, connected to the carrier's frequency through a gain of `depth × startHz × ratio`, and both stop at `durationS`.
- The carrier glides from `startHz` to `endHz`.
- The loudest sound in `BALL_CRIES` peaks at least 12 dB under unity through `BALL_GAIN`, like the existing test.
- `ObjectSounds.cry` plays the listed variant on the ball; an out-of-range variant or a vacuum's id does nothing; it plays regardless of who kicked.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/web/src/audio`
Expected: FAIL.

- [ ] **Step 3: Implement**

`cry` goes through the existing master gain, so it's spatial via the existing `attachNode` and stays under voices. `room.ts`'s `objectState` handler plays `m.cry` when both fields are present, after `ball.server`, so stale states stay silent. The `forTests` additions are reached only through `window.__game`, which `main.ts` sets in dev builds.

- [ ] **Step 4: Run the tests, then commit**

Run: `pnpm exec vitest run apps/web/src/audio`
Expected: PASS.

```bash
git add apps/web/src
git commit -m "Give the ball its FM cries, with a dev way to play them"
```

### Task 6: Docs, measurements and tuning

**Files:**
- Modify: `docs/open-decisions.md`, `AGENTS.md`, `docs/superpowers/specs/2026-10-23-ball-design.md`
- Throwaway, not committed: the measurement script, in the scratchpad

- [ ] **Step 1: Record the decision**

- Add D33 to `docs/open-decisions.md`, with the owner's choices (puppy, kick puts it to sleep, server brain, 15 s give-up, up to five sounds, portal fright only, no jumps).
- Add a short "living ball" gotcha to `AGENTS.md`: the mind only sets velocity at or below its own speed, a kick goes through `kickBallMind`, the shake is drawn only.
- Note in the ball spec's non-goals that D33 supersedes "plain rolling" while keeping the physics.

- [ ] **Step 2: Run everything**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`
Expected: all pass. If an e2e spec turns out to rely on a still ball, have that spec's server turn the mind off, rather than changing the mind. A search of the current specs finds no ball or kick in them.

- [ ] **Step 3: Measure the jumps**

Rebuild the two-player script from the `ball-kick-followups` memory: scripted players plus a watcher, real prediction code, run against a local server with about 50 ms of added latency each way.
- **Kicks:** 5 minutes with `ballMind` off, then 5 with it on. Expected: on has no more jumps over 0.6 tiles than off.
- **Awake:** 5 minutes, no kicks, players pushing and walking past. Expected: no drawn correction over 0.6 tiles at once.

Failure of either blocks shipping: report the numbers to the owner.

- [ ] **Step 4: Play it, and check what tests can't**

Join a local room with `pnpm dev`. Confirm by eye:
- the tremble is visible at several distances
- the shake is followed by the shadow and floor mirror, including through a portal window
- it stays still on the frame of a kick
- it stops within kick reach

- [ ] **Step 5: Commit, then hand over for the owner's tuning**

```bash
git add docs AGENTS.md
git commit -m "Record the living ball (D33)"
```

The owner tunes speeds and sounds by playing, using `__game.ballCry` and `__game.forceBallMood`. Apply what comes back in small commits.
