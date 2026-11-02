# The living ball: a puppy that is still a ball

Status: design for owner approval. Follows the ball spec (`2026-10-23-ball-design.md`, D26) and builds on PR 132 (the
push drift limit), which isn't merged yet. Decision record: D33 (D32 is taken by the postponed eye adaptation, PR 130).

Calls marked **(my call)** were made by the designer, not the owner, and can be overridden.

## 1. Intent

Today the ball only reacts to physics. The owner wants it to have a personality: left alone, it wakes up, moves by
itself, notices people and makes sounds that show how it feels. It must remain a ball people can play with, so a kick
always wins over anything it is doing.

The owner chose the character of a curious puppy: it comes over to people, wiggles at their feet, follows them when they
leave and is scared when it ends up somewhere strange alone.

### Goals

- **Sleep and waking (owner):** a person's kick puts it to sleep at once. It wakes 10 s after the last kick. Pushes and
  touches are fine and don't put it to sleep.
- **Moves and reacts (owner):** the states in §2, slower than a walking person.
- **Emotions as FM sounds (owner):** each emotion has one to five FM sounds (§5).
- **Scared when lost (owner):** falling through a portal with nobody there frightens it.

### Non-goals

- **Jumps (owner: "no jumps for now").** The ball stays on the floor with no height.
- Other frights, such as the room going dark (owner: the portal is enough for now).
- Understanding portals: it can roll through one by accident, but doesn't aim for or through them **(my call)**.
- Pathfinding: it only heads for places it can see in a straight line **(my call)**.
- A face or other visual expression, and telemetry for its moods.
- Bots affecting it, as with the ball today **(my call)**.
- Saving its mood across a server restart **(my call)**: it starts asleep. The snapshot format doesn't change.

### Anti-goals (a failure even if it works)

- **A kick interleaves with its behaviour:** any steering, wiggle or trembling continuing on a kicked ball.
- **Dribbling or kicking changes:** the ball is harder to catch, kick or dribble awake than asleep, or kicks land with
  different results than today.
- **Jumps come back:** its self-movement causes visible corrections beyond the small glide in §4.
- **It talks over people:** it is frequently audible during a meeting, or as loud as a voice.
- **It costs frame rate:** no per-frame allocations; `pnpm bench:sprites` holds.

## 2. The state machine

A tagged union in the style of `VacuumActivity`, in a pure module `packages/shared/src/objects/ball/mind.ts` **(my call
on the name)**. All values are starting points, tuned by playing **(my call)**.

| State | Behaviour | Leaves when → to (sound) |
|---|---|---|
| `asleep` | No steering, silent; its timer runs | 10 s after the last kick → `wandering` (yawn), or `scared` (whimper) if it crossed a portal since falling asleep and sees nobody |
| `wandering` | Rolls to a random visible spot within about 3 tiles, pauses 1–4 s, repeats | Sees a person → `approaching` (happy) |
| `approaching` | Rolls towards its person | Reaches their feet → `wiggling`; loses them → `following`; chase over → `wandering` (sad) |
| `wiggling` | Rests just short of their feet; the wiggle is drawn (§4) | They move out of its stopping range → `following` |
| `following` | Rolls towards its person, or their last seen spot if out of sight | Reaches them → `wiggling`; chase over → `wandering` (sad) |
| `scared` | Rests; the trembling is drawn (§4) | Sees a person → `approaching` (relieved); after about 6 s → `wandering` |

**Giving up (owner):** a chase lasts about 6 s in total across `approaching` and `following`, however often it switches
between them, and restarts only on reaching the person. When it ends, the ball ignores that person for **15 s**, unless they
come within about 2 tiles, which forgives them early. Someone else can catch its attention as soon as it gives up, but not
during a chase. So someone pacing around at most draws one sad note every 20 s or so.

**From any state:**

- **A person's kick** → `asleep`, with a yelp if it was awake. Kicking a ball that is already asleep only restarts its
  10 s, with no yelp, so repeated kicks don't produce repeated yelps.
- **Crossing a portal while awake,** nobody in sight → `scared` (whimper). Someone in sight → `approaching` (yip). No
  state can hold this off, and while already `scared` it restarts the 6 s.
- **Crossing a portal while asleep** changes nothing but remembers the crossing for waking. It stays silent during the roll.

**One-off sounds with no state change, only while awake:**

- The first push by a person after **5 s** with no push: giggle, so a long dribble giggles once and not every 3 s **(my call)**.
- A vacuum knock: startled. A vacuum never puts it to sleep; only a person's kick does **(my call)**.

### Senses

- **Seeing a person:** the nearest connected person (never bots) within **6 tiles** with `hasLineOfSight`, straight through
  the map and ignoring portals **(my call)**. A chosen person stays its person until it leaves them, so it doesn't flip
  between two people standing close together **(my call)**.
- **Empty room:** nothing steps while nobody is connected, as today.

### Physics comes first

The mind never touches the ball while it moves faster than its own speed. A push, kick or bounce plays out by the existing
physics, and steering resumes only once the ball has slowed down to it, with no change of state.

- A dribbler keeps the ball above that speed, so dribbling an awake ball is the same as dribbling a sleeping one.
- The mind only ever sets the velocity, and only at or below its own speed. `stepBall`, `kickBall` and their constants
  don't change, except that the physics must report a portal crossing and a push (§3).

| Constant | Value | Why |
|---|---|---|
| Own speed | **1** tile/s | Walking is 3, so anyone can catch it |
| Stopping distance | touching distance + **0.25** tiles | Not touching, so it doesn't count as a push, and still in kick reach (touching + 0.5) |
| Leaves `wiggling` beyond | touching distance + **1** tile | So small shuffles don't trigger a chase |
| Wake | **10 s** after the last kick (owner) | |
| Sound cooldown | **3 s** shared, all sounds except the yelp | Keeps it occasional (§5) |

## 3. Who runs it: the server, and clients follow

### Approaches considered

1. **The brain on the server, clients follow its states (owner's pick).** Almost no new prediction code. During the 300 ms
   after a push the local ball can be up to about 0.3 tiles off, and glides back. About 15 updates per second while it rolls.
2. **The brain on the server, clients also predict its steering.** Slightly smoother, but more code and more ways to
   disagree, in the code where teleports have only just been reduced. Hard to notice at 1 tile/s.
3. **The brain only on clients.** Rejected: everyone would see the ball in a different place and kicks would miss.

### Server

- `Lobby.stepBalls` runs the mind each tick, before `stepBall`, for the rooms it already steps. Everything runs in one
  thread: `Lobby.kick` sets `asleep` as it applies the kick, so the next tick can't steer that ball.
- A new `Lobby` option turns the mind on, off unless set **(my call)**, as `vacuum` and `ball` are, so tests with a ball
  keep their results.
- **What the mind needs from `stepBall`:** that a person pushed it and that it crossed a portal. How it's reported is left
  to the builder, as long as the existing return value and the client's per-frame stepping stay free of allocations.
- **Broadcast:** `object_state` goes out as today, and also when the mood changes or a sound plays, even if the ball rests.
  A ball resting in any state sends nothing else.

### Protocol

- `object_state` and `welcome.objects` entries for the ball gain optional `mood`, so someone joining sees the right
  behaviour. Missing means `asleep`.
- `object_state` gains optional `cry` (the emotion) and `cryVariant` (which of its sounds). These are new fields rather
  than new `ObjectEvent`s, because one message can carry both a bounce and a cry.
- **No `PROTOCOL_VERSION` bump** **(my call)**: the parser already drops unknown fields, and server and web ship together.
  The builder confirms this.

### Client

- `ball-prediction.ts` keeps its position logic unchanged, and gains the mood.
- **A local kick sets the local mood to `asleep` at once,** and server moods are ignored until the kick is answered, using
  the existing `unechoed` hold. A refused kick takes the server's mood again. So the wiggle stops on the frame of the kick.

## 4. Look

The wiggle and trembling are **drawn only**: a small offset added where the client places the ball
(`remote-world.ts`, `sampleObjects`), never to its physics or to what is kicked **(my call)**. They can't fight a push, and
send nothing over the network.

- **Wiggle:** about ±0.05 tiles side to side at about 2 Hz.
- **Tremble:** about ±0.03 tiles at about 14 Hz. A voxel is 0.05 tiles, so this is checked by eye at a few distances.
- Shadow and floor mirror follow the drawn position, in the main view and through portal windows. The roll is computed
  from the ball's real position, so a shake doesn't turn its pattern.

## 5. Sound

Nine emotions: yawn, happy, relieved, sad, yelp, giggle, whimper, yip and startled.

- **One to five FM sounds each (owner).** A sound is plain data: frequency ratio, modulation depth, pitch glide, duration.
  The table lives in `packages/shared/src/objects/ball/cries.ts`, with no Web Audio in it, so the server knows how many
  each emotion has **(my call)**. The builder writes a first set, as many per emotion as sound distinct; the owner tunes by
  ear.
- **The server picks the sound,** never the same one twice in a row for an emotion, so everyone hears the same one and can
  react to it together **(my call)**.
- **All of them come from the server, the yelp included.** The kicker hears the existing thump at once and the yelp about
  100 ms later, which suits the sequence, and a refused kick gets no yelp **(my call)**.
- **Quiet by design (owner agreed):** sounds play only on the changes in §2, with a shared 3 s cooldown; a sound due during
  the cooldown is dropped, except the yelp, which is rare by construction. No sound repeats while a state lasts.
- They go through the ball's existing output and `AudioEngine.attachNode`, so they are spatial, muffled through walls, and
  below voices. Same master level as the ball to start (`BALL_GAIN`).
- **Dev-only audition (my call):** `window.__game` can play any emotion's sound by index and force a mood, because a whimper
  can't otherwise be summoned for tuning. Not in production builds.

## 6. Testing

- **Failing tests first** for the mind: every transition in §2, the cooldown, no repeat, never steering above its own speed,
  a kick from each state, an asleep crossing that wakes `scared`, and the stopping distance staying in kick reach.
- **Lobby:** a kick lands the same way on an awake ball as on a sleeping one; nothing goes out for a ball resting in any state;
  the mood reaches a new joiner; bots aren't seen.
- **Prediction:** a local kick clears the mood on that step, ignores server moods until answered, and a refusal restores it.
- **Protocol** round trip of the new fields.
- **Existing specs:** the mind is off by default in unit tests. Any e2e spec that expects the ball to stay put needs to account
  for it, or turn it off.
- **Measure the jumps (my call):** PR 132's numbers came from prod and from a ball that was kicked constantly, so they can't be
  compared directly. Two runs on one local server with about 50 ms of added latency each way, rebuilding the throwaway script
  from `ball-kick-followups`:
  - **Kicks:** the same 5-minute two-player run with the mind off, then on. On must be no worse in jumps over 0.6 tiles.
  - **Awake:** 5 minutes of no kicks, with scripted players pushing and walking past the steering ball. The drawn ball must
    never correct by over 0.6 tiles in one go. A failure of either blocks shipping.
- **Owner plays it** to tune speeds, distances and sounds.

## 7. Left to the builder

- Internal types and the exact shape of the mind's input.
- The source of randomness, matching how `Lobby` already injects it.
- Which sub-step of a tick counts for a portal crossing or a push.
