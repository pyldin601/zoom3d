# Portal sequence: a shared blackout when portals switch

Date: 2026-10-29. Status: draft for review. Builds on D27 (portal doorways), D28 (portal lamp light) and D29
(portal glow).

## 1. Intent

Today, pressing Y bends the room instantly. This makes switching portals a shared, dramatic event that everyone in the
room sees and hears at the same moment.

- **The first time** portals come on in a room, the room counts down, goes black, and the portals light up alone in the
  dark before the lamps return.
- **Every switch after that**, on or off, is a short blackout.

## 2. What it does

### 2.1 The sequences (the user's design, 2026-10-29)

**First switch-on in a room (`first_on`), 7 s from the press:**

| From | Until | What happens |
|---|---|---|
| 0 s | 3 s | Text on screen: "Portals will enable in 3…", then "2…", then "1…", one number a second. |
| 3 s | 5 s | **Darkness.** A deep, dramatic lights-off sound with reverb plays, and every lamp goes out at once. |
| 5 s | 7 s | **The portals light up alone in the dark** (windows, rim, spill, hum) with the "portals on" sound. The space bends at 5 s. |
| 7 s | | **The lamps come back**, with the "lights on" sound. |

**Every later switch, on or off (`on`, `off`), 1 s from the press:**

| From | Until | What happens |
|---|---|---|
| 0 s | 1 s | **Darkness:** the same lights-off sound, and every lamp out. There is no countdown. |
| 0.5 s | | Switching off: the portals vanish and the space unbends. Still dark. |
| 1 s | | The lamps come back, with the "lights on" sound. Switching on: the portals appear with them, with the "portals on" sound, and the space bends (amended 2026-10-29, the user: portals and lights turn on together after the first switch-on). |

### 2.2 Darkness

- **Every lamp goes out:** lamp light, fill (bounce) light, ambient light, ceiling fixtures and lamp reflections.
  Anything lit only by lamps goes black.
- **Things that glow keep glowing** (the user's words: "objects keep glowing"):
  - people's faces, at their own brightness, and the glow they throw around them;
  - in `first_on` from 5 s, and in `on`/`off` while the portals are on, the portal windows, rim, spill and hum.
- **A portal window is dark too** (the user's choice, 2026-10-29). The room beyond a window has its lamps out like
  every other, so a lit portal in the dark is a glowing pink frame (rim, shimmer, spill) around a black opening. That
  is the true blackout, and it doesn't give away where a portal leads before the lights return. Window passes read
  the same black table as the main pass.
- **Name labels, the status line and the automap stay as they are** *(our call: they are interface, not the room)*.
- **People can keep walking** during the countdown and in the dark *(our call)*.
- **Unlit rooms** (`?lights=off`, or the flat render mode) have no lighting to switch off. The countdown and sounds
  still play there, and the frame doesn't go dark *(our call: that mode has no light model to darken)*.

### 2.3 The sounds (synthesised, tuned with the user in a sketch first)

Three sounds (amended 2026-10-29: the user moved the lighter sound to the portals' moment, and asked for a third for
the lamps; they approved the sketch by ear).

- **Lights off**, when the dark falls: deep and dramatic, a heavy breaker throwing and a huge room losing power.
- **Portals on**, when the portals light up (only when they turn on; a switch-off has no sound at its bend).
- **Lights on**, when the lamps come back: a breaker click, fluorescent flicker, then a faint mains hum.
- **All play for everyone, at the same level wherever each person stands.** They are not placed in the room; they
  are the building's power. They go through the room's reverb: each sound's own tail from the recipe below, with
  no send into the voices' shared reverb, whose short tail would change the approved sound.
- **Their level sits under voices.** The sketch's levels are relative; the game scales them so the loudest stays
  under a voice.

**Recipe** (the sketch as approved; times in seconds from the cue, levels are each sound's output gain before the
game's scaling; "reverb" is a dry/wet send to a decaying-noise impulse of the given tail):

- **Lights off** (length 1.2, level 0.8, reverb tail 3.5 s at 0.55 wet):
  - a sine falling exponentially from 90 Hz to 32 Hz over the length; gain 0 → 1 in 0.01, then exponentially to
    0.001 at the length;
  - a "thunk": 0.4 s of white noise through a 260 Hz low-pass, gain 0.9 (0.6 × 1.5) falling exponentially to 0.001
    in 0.35.
- **Portals on** (length 0.7, level 0.45, reverb tail 1.2 s at 0.3 wet):
  - a sine rising exponentially from 140 Hz to 520 Hz over the length; gain 0.0001 → 0.6 (exponential) at 0.6 of the
    length, then to 0.001 at the length + 0.25;
  - a 100 Hz sawtooth "buzz" through a 900 Hz low-pass; gain 0.0001 → 0.0875 (0.35 × 0.25) at 0.7 of the length,
    then to 0.0001 at the length + 0.3.
- **Lights on** (level 0.5, reverb tail 1.5 s at 0.35 wet, span 0.3):
  - a click: 0.05 s of noise through a 1600 Hz band-pass (Q 2), gain 1.6 falling exponentially to 0.001 in 0.04;
  - no flicker ticks (the user removed the "takata" after playing it, 2026-10-29);
  - a 100 Hz sawtooth hum through a 700 Hz low-pass; gain 0.0001 → 0.045 (0.3 × 0.15) at the span + 0.1, then to
    0.0001 at the span + 1.2.
- **Countdown** (added 2026-10-29, picked by the user in the sketch): one pulse as each number shows, at 0, 1 and 2 s
  of `first_on` (level 0.3, reverb tail 1.2 s at 0.3 wet):
  - a 440 Hz triangle; gain 0.0001 → 0.5 (exponential) in 0.003, held to 0.25, then exponentially to 0.0001 at
    0.25 + 0.04; the oscillator stops at 0.31.

### 2.4 Who starts it, and the debounce

- **Y still sends `{ type: 'portals' }`.** The server answers by starting a sequence for the whole room.
- **The debounce follows the sequence** (the user: "align portals on/off debounce"). While a sequence runs in a room,
  Y presses are ignored. The fixed one-second flip gap (`PORTALS_FLIP_GAP_MS`) is replaced by "a sequence is
  running": 7 s for `first_on`, 1 s for `on`/`off`. When a sequence ends, the next press starts the next one at once.
- **The move check** keeps accepting either mode for 1 s after the bend, as today (D27).

### 2.5 Keeping everyone in step (approach A, chosen)

- **One message per sequence:** `{ type: 'portals_sequence', kind: 'first_on' | 'on' | 'off', age: number }`.
  - `age` is the milliseconds since the sequence started on the server, as the `peers` batches carry it (D23).
  - The client stamps the start as `arrival − age` and runs every step from shared timing constants in
    `packages/shared`.
  - Clients end up within one network delay of each other: tens of milliseconds, up to about 0.1 s on a slow phone
    connection. The presser sees it a round trip after pressing. The user accepted this (2026-10-29): nobody sees
    another's screen, and there is no clock syncing.
- **The bend is the server's.** At the bend moment, the server flips the room's flag and broadcasts the existing
  `{ type: 'portals', on }`. Clients bend their space on that message, as today.
  - The portals' glow and hum follow the flag, as they do now, so they appear when the space bends.
  - The darkness and the three sounds follow the sequence's timeline, except that the lamps wait for the bend
    (amended 2026-10-29, D30): from the dark, a client stays dark while its flag differs from the sequence's target,
    up to 2 s past the lamps' moment, and the lights-on sound plays when they really return. A flag at the target
    before the bend's moment means a stalled tab got the press and the bend together: the client jumps to the bend.
- **Joining or resuming mid-sequence:** the welcome carries `sequence?: { kind, age }` while one is running. The
  client jumps to the right step, for example straight into the dark. A sound whose moment has passed by more than
  about 0.3 s is not played late *(our call)*. The welcome is built after the server advances the sequence, so it
  never carries one past its end. A resume welcome restamps the running sequence: a stamp of the same kind within
  500 ms of the first is the same sequence, and the client keeps its first stamp.
- **`PROTOCOL_VERSION` 4 → 5.**

### 2.6 Remembering the first switch-on

- **A room records that its portals have been on once.** The first press after that gets `on`, never `first_on`.
- **This survives a server restart:** an optional `portalsEverOn` in the room's entry in the state file, next to
  `portals`. `LobbySnapshot` stays version 1, because a missing field reads as "never".
- **A room that closes and opens again starts fresh** *(our call: a room's state lives as long as the room)*.
- **The flag is set at the bend,** not at the press *(our call)*.
- **A sequence running when the server restarts is dropped,** not saved: the press is lost, and a room that hadn't
  reached the bend keeps its big first switch-on for next time *(our call)*.

## 3. Goals, non-goals, anti-goals

**Goals:**
- Everyone in a room sees the countdown, the darkness, the lone glowing portals and the lamps returning together,
  within tens of milliseconds, with the three sounds.
- The first switch-on is the big one; every later switch is a quick blackout.

**Non-goals:**
- Fades: the lights switch instantly.
- A countdown for later switches or for switching off.
- A setting to skip the sequence.
- Spatial placement of the three sounds.

**Anti-goals (a failure even if it works):**
- Players out of step by more than their own network delay (no step may add its own wobble on top).
- The space bending while the lamps are on, so someone sees the world change mid-step.
- A frame hitch when the lights go out or come back.
- Mashing Y producing overlapping sequences, or a sequence restarting.
- With no sequence running, anything different from today: same pixels, and the portals-off bench hashes hold.

## 4. Constraints

- **No allocations** in the per-frame path. Darkness is a table swap, like D28's portals-on table.
- **Logic is test-first:**
  - the shared timeline: which step a given age falls in, and when the bend comes;
  - the server's sequence state: starting, ignoring presses while running, the bend broadcast, and
    `portalsEverOn` in the snapshot;
  - the protocol messages and the welcome field;
  - the client's step at a given time, and joining mid-sequence.
- **Rendering and sound are checked by playing.** One Playwright spec checks that a second tab gets the sequence and
  goes dark.
- **Record the decision** in `docs/open-decisions.md` as D30.

## 5. Approaches considered

- **Sync, A: one message with kind and age, the timeline in shared code (chosen).** It is robust to network wobble,
  joiners fit in naturally, and it's one message per press.
- **Sync, B: a message per step.** Simpler to read, but each step jitters separately, and it sends six messages per
  press.
- **Darkness, A: a third, pitch-black lighting table (chosen).** No lamps, no ambient, no bounce, baked in almost no
  time with the other two, and swapped in instantly. Glows add their light on top as usual. It costs nothing per frame.
- **Darkness, B: a brightness factor at every pixel.** It would allow fades, but every frame would pay for it, even
  with the lights on.
- **Sounds:** synthesised with Web Audio, like the vacuum and the portal hum. No files, and they're tuned by ear in a
  sketch.

## 6. Left to the builder

- **The countdown's look.** Big centred text, consistent with the room's existing notice (`ui/portal-notice.ts`), and
  how the existing "Portals on/off" notice fits around the sequence. It could show when the lamps return, or not at
  all.
- **Where the black table is baked and how it is picked,** alongside `createRoomLighting` and `describeScene`.
- **How faces keep their own brightness in the dark,** if discs are shaded by the lighting today.
- **How the three sounds bypass placement.** Each carries its own reverb (§2.3); the engine only plays them, unplaced.
