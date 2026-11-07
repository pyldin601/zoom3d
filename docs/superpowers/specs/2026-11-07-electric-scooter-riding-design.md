# Electric scooter riding

Date: 2026-11-07. Status: approved by the owner 2026-11-07. Builds on the kick scooters
([spec](2026-11-07-kick-scooter-design.md), D36), on the same branch (PR 142).

## 1. Intent

The scooters are **electric**. Today riding is walking at twice the speed: it starts and stops at once, and A/D strafe.
The owner wants it to behave like a real e-scooter:
- it moves along its heading only;
- it speeds up and rolls on with inertia;
- it steers;
- it hums like a motor;
- it is visibly held while ridden.

## 2. Goals, non-goals, anti-goals

**Goals** (owner's answers, 2026-11-07)

- **Throttle:** W (or pad up) runs the motor, and the scooter speeds up smoothly to `RIDE_SPEED` (6 tiles/s).
  Releasing it coasts: the scooter rolls on and slows gently.
- **S (pad down):** brakes hard while rolling forward. Once stopped, holding S rolls backward at a slow walk.
- **Steering:** no strafing. A/D (pad left/right) steer like the arrows, and turning is wider at full speed. It turns only
  while rolling, and backing up swings the nose the other way (owner, 2026-11-07).
- **Items:** a drink, the lighter or the boombox is put away while riding (both hands on the bar), and comes back on
  stepping off.
- **First person:** the handlebar is at the bottom of the screen and tilts as the rider steers.
- **Motor sound:** an electric whine, heard from the rider, whose pitch climbs with speed. It is a little louder while
  speeding up and fades to silence when stopped. It is subtle and stays under voices, like the vacuum.
- **The look:** the scooter gets a glowing headlight on the stem and a dark battery under the deck. This is looks only;
  the headlight lights nothing.

**Non-goals:** power-on chirps, an idle hum, kicks or any rider bob (riders glide flat), a headlight that lights the
room, a battery that runs out, changes to the server or the protocol.

**Anti-goals** (failure even if it works)

- Steering lags. The rider's own screen runs the physics, never the server.
- The motor covers a conversation.
- A rider is corrected by the server. The top speed and the move check stay as they are.

## 3. Approaches

- **Chosen: the physics runs on the rider's screen** in one pure function; others see the motion as they see any
  walker. The server only keeps its speed check. Everyone hears the whine worked out from the rider's motion as they
  see it, so the protocol is unchanged.
- **Rejected: the server simulates the ride.** Players move themselves in this game and the server only checks them.
  Putting it in the loop would lag steering by a round trip.
- **Rejected: a "motor on" flag on the wire** (the owner chose motion over a flag for the earlier kick question).
  It is exact, but it costs a protocol bump and server relaying for a cosmetic sound.

## 4. Design

### 4.1 The ride (`apps/web/src/game/scooter-physics.ts`, pure, tested)

`stepRide(ride: RideState, input: MoveInput, dt: number)` moves `ride.speed`, in tiles/s along the heading (negative
means backing up). All values are starting values, to be tuned by playing.

- **Speeding up and slowing down:**

  | Situation | Behaviour |
  |---|---|
  | `forward > 0` (throttle) | +4 tiles/s², capped at `RIDE_SPEED` (0 to full in 1.5 s) |
  | no throttle, rolling either way | slows by 1.5 tiles/s² toward 0 (about 4 s from full) |
  | `forward < 0`, rolling forward | brakes at 10 tiles/s² (about 0.6 s from full) |
  | `forward < 0`, at or below 0 | backs up toward −1 tile/s at 3 tiles/s² |
- **Steering:**
  - while riding, the input's `strafe` is added to `turn` (A/D steer), clamped to [−1, 1];
  - the keyboard turn rate is `min(1, |speed| / 0.5) × TURN_SPEED × (1 − 0.4 × |speed| / RIDE_SPEED)`, so none at a
    standstill and 60% at full speed, and its direction flips while backing up (front-wheel steering) (owner, 2026-11-07);
  - the mouse and touch drags turn the scooter instantly, as on foot (owner, 2026-11-07, over capping them at speed
    and over a separate look direction): the view and the scooter share one angle.
- **Walls** (builder's call, after the builder check; frame-rate independent):
  - the step is the speed along the heading, passed through `moveWithCollision`, which slides along a wall on the free
    axis;
  - head-on means the step was blocked on both axes, or the heading is within 20° of the wall's normal. Then
    the scooter stops dead: `speed = 0`;
  - otherwise, scraping along a wall (one axis blocked), the speed falls at the braking rate (10 tiles/s²) for as long
    as it scrapes, so a long scrape slows it to a stop;
  - portals carry the rider as they do on foot (`carryThroughPortal`), and the speed carries over.
- **Mounting and stepping off:** stepping on starts at speed 0. Stepping off drops the speed, and walking resumes at
  once, even at full speed.
- **Wiring:**
  - `LocalPlayer.walk` uses `stepRide` while `riding`, and `stepPlayer` on foot;
  - `ScooterRide.forwardSpeed()` and `stepPlayer`'s `forwardSpeed` parameter are removed, since nothing uses them any
    more;
  - the server's move check is unchanged: the top speed is `RIDE_SPEED`, and backing up is slower than walking.

### 4.2 Items put away (rendering only, every screen)

- While a person rides, their sprite has `held: null` and `boombox: false`, and their lighter neither lights nor
  appears among `lighters`. The same goes for the local player's disc, their first-person items and their own lighter.
- The chosen item isn't changed or sent: `session.held` stays as it is, so it shows again on stepping off. A number key
  pressed while riding still changes the choice, which shows on stepping off. Sip and cheers keys do nothing while
  riding.
- The boombox's music keeps playing; only its sprite is hidden.
- Putting the lighter away by riding plays no lid click (builder's call: a click is for the hand, not the ride).

### 4.3 First person: the handlebar

- A pixel sprite in the style of `own-held.ts`, drawn by `drawFirstPerson` while riding, in place of the held item and
  boombox. It shows the top of the stem coming up from the bottom centre, the bar across it, and dark grips at both
  ends, with its lower part cropped by the screen edge.
- Steering tilts it: the grips move up and down in opposite directions by up to 3 texels, and the whole bar shifts up
  to 2% of the width toward the turn, following the turn input with a short ease (about 0.1 s).
- It never bobs.

### 4.4 The motor's whine (replaced)

Replaced on 2026-11-07 by the owner's tuned sound: see the [scooter sound spec](2026-11-07-scooter-sound-design.md).
What follows is the first version, kept as history.

#### The first version (`apps/web/src/audio/scooter-sound.ts`, plus a per-rider manager)

- **Synthesis:** two slightly detuned oscillators (sawtooth, a few cents apart) through a band-pass filter,
  synthesised like the vacuum. (A faint high harmonic was dropped in building: the two sawtooths carry enough.)
  - Pitch from speed: 180 Hz at a crawl, rising to 720 Hz at `RIDE_SPEED`.
  - Level: proportional to speed, silent below 0.3 tiles/s, and 30% louder while speeding up.
  - Every change is smoothed (time constant about 0.1 s), so it never clicks.
- **Master level:** `SCOOTER_GAIN`, about the vacuum's (0.04), tuned by ear.
- **Who hears what:**
  - Others' whine is spatial, through `AudioEngine.attachNode` keyed by the rider (like the vacuum's hum).
  - The local player's own whine is unplaced (`playUnplaced`, like the own lighter), from their own `RideState`.
- **Motion source for others:** speed and acceleration come from the rider's drawn positions per frame, smoothed over
  about 0.15 s. A rider who teleports or crosses a portal (a jump over `JUMP_TILES`) is not counted as speed.
- **Lifecycle:** a rider's sound starts when they step on (or appear riding) and stops when they step off or leave.
  Dismounted scooters are silent.

### 4.5 The look (`renderer/models/scooter.ts`)

- A headlight voxel on the front of the stem, about two-thirds up, made `glowing()` like the vacuum's eyes.
- A dark battery box under the deck between the wheels, inside the current 12 × 4 × 11 grid.
- This changes the scooter bench hash; no other hashes change.

## 5. Tests

- **`scooter-physics`:**
  - throttle reaches 6 tiles/s in about 1.5 s and never exceeds it;
  - coasting from 6 slows to about 0 in about 4 s;
  - S brakes, then backs up to −1 tile/s and no faster;
  - strafe steers;
  - the turn rate is 60% at full speed;
  - a head-on wall (or one within 20°) gives speed 0;
  - scraping a 45° wall loses 10 tiles/s² × the scrape's duration, the same at 30 and 144 frames a second;
  - speed carries through a portal.
- **`remote-world` / `local-player`:**
  - a rider's sprite shows no held item, boombox or lighter, and comes back on stepping off;
  - the own lighter is off while riding;
  - riders never bob.
- **`own-held` or a new `own-handlebar.ts`:**
  - the handlebar draws only while riding;
  - steering tilts it;
  - nothing bobs.
- **`scooter-sound`** (with `fake-audio.ts`, like the vacuum's):
  - pitch and level follow speed;
  - silence when stopped;
  - the speed-up boost;
  - smoothing (no instant jumps).
- **Sound manager:** it starts a sound for a peer who steps on, stops it on stepping off or leaving, and ignores jumps.
- **e2e `scooter.spec.ts`** is updated:
  - after 1 s of W from a standstill the rider has covered over 1.5 tiles (about 2 at 4 tiles/s²) but under 6;
  - after releasing W they keep rolling.

## 6. Left to the builder

- Exact pixel art and colours of the handlebar.
- The whine's filter values.
- How the sound manager is split between `object-sounds.ts` and a new file.

The numbers in §4.1 and §4.4 are starting values for the owner to tune by playing.

## 7. Amendment: the mouse turns the head, not the scooter (owner, 2026-11-07)

This replaces §4.1's "the mouse and touch drags turn the scooter instantly". The owner first chose that, then asked
for "no instant rotation, only turn head".

- **While riding, the mouse and touch drags turn only the rider's head.** The head's angle is relative to the
  scooter's heading, clamped to ±90° (owner), and stays where it is left (owner, over easing back). Only the steering
  keys (A/D, the arrows, the pad's sides) turn the scooter, at the speed-limited key rate.
- **What others see:** the pose sent to the server keeps the scooter's heading, so a ridden scooter points where it
  is going. Faces are billboards, so the head shows nowhere else.
- **What follows the head:**
  - the camera (`eye` = heading + head);
  - the spatial-audio listener;
  - the apparent world;
  - the own label;
  - face subscription (what is in view);
  - portal hums;
  - a kick's direction.

  Position-only uses (sampling peers, scooter reach) don't care.
- **The handlebar** stays with the scooter. In first person it shifts sideways by where straight ahead would project
  on screen, so it slides out of view as the head turns past half the field of view.
- **Stepping off:** the body turns to face where the head looked (`pose.angle += head`), and the head returns to 0.
  Stepping on starts with the head straight. Portals carry the heading and leave the head as it is.
- **Tests:**
  - riding, a mouse turn changes the eye but not `pose.angle`;
  - the head clamps at ±90°;
  - the head stays after the mouse stops;
  - stepping off faces the look;
  - on foot, the mouse turns `pose.angle` as before;
  - the handlebar is off screen at 90°.
