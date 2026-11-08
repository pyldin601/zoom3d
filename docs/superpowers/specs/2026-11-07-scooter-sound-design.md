# Scooter sound

Date: 2026-11-07. Status: approved by the owner 2026-11-07. Replaces §4.4 (the motor's whine) of the
[electric scooter spec](2026-11-07-electric-scooter-riding-design.md).

## 1. Intent

The first whine (two sawtooths, 180 → 720 Hz with speed) wasn't how an e-scooter sounds. The owner described it:
- a PWM motor's whiss;
- with wheel noise barely heard;
- bumps that make a sound.

The owner tuned the sound by ear on a listening page (the Scooter Sound Bench) and sent the values below. On the
same page the owner dropped two parts: the metal ring on a bump, and any sound for scraping along a wall.

## 2. Goals, non-goals

**Goals:**
- Every value below is built into the game as tuned.
- Everyone nearby hears a rider's motor, wheels and bumps from the rider's spot. The rider hears their own unplaced.

**Non-goals:**
- A scrape sound (dropped by the owner).
- A ring on bumps (dropped).
- Chirps or an idle hum.
- Protocol or server changes.

## 3. Approaches

- **Chosen: build the bench's synth as it is**, so what the owner tuned is what plays. Every screen works out the
  load (speeding up, holding speed, coasting) and the bumps from motion: the owner chose "everyone nearby, from
  motion" for bumps, as for the whine.
- **Rejected: sample recordings.** They would need assets and licences. The owner tuned a synth and liked it.

## 4. The sound, layer by layer (owner's values)

The load decides how loud the motor layers are:

| Load | When | Own screen | Others' screens |
|---|---|---|---|
| speeding up | throttle held, below top speed | from the input | speed over the last window up over 0.6 tiles/s on the window before |
| holding speed | throttle held at top speed | from the input | neither, and moving (≥ 0.3 tiles/s) |
| coasting | everything else | from the input | speed down over 0.35 tiles/s, or nearly still |

*Amended after review (2026-11-07):* others' motion is read from the poses the server sent of them (their snapshot
buffer), not from where they are drawn frame by frame. Drawn positions freeze just before a portal jump, slow down
while the draw delay changes tier, and wobble with the 66 ms tick grid. All three read as false bumps and a load
that flickered.
- Speeds are averaged over windows of 350 ms, or two update intervals for far riders.
- A load is heard only once it has held 300 ms, except stopping, which is immediate.

Layers:

- **PWM whiss:** fixed at 7800 Hz whatever the speed.
  - A sine at gain 0.65 (1 − 0.5 × 0.7), plus noise through a band-pass at 7800 Hz, Q 12, gain 3.0 (0.5 × 6).
    *Amended 2026-11-07 (owner):* the hiss's gain is 1.5, half of that (80% was still too loud).
    *Amended 2026-11-08 (owner):* 0.15, a tenth of that.
  - Level 0.35 speeding up, 0.18 holding speed, and 0.02 × `min(1, speed / 0.3)` coasting.
- **Motor tone:** *removed 2026-11-07 (owner).* It was a triangle, its second harmonic and a low-passed square at
  `max(30, 157 × speed / 6)` Hz, at levels 0.03, 0.02 and 0.01.
- **Magnetic whine:** *added 2026-11-08 (owner: "like gears, but based on a magnetic field rather than physical
  teeth"), tuned by ear on the Scooter Motor Whine listening page.*
  - The magnet rate is `210 × speed / 6` Hz: how many magnet pairs pass a coil each second.
  - Four sines at multiples of it: ×1 at gain 0.12, ×2 at 0.08, the slot tone at ×2.22 at 0.3, and ×12 at 0.06.
    The slot tone and ×12 form an upper bus, raised 1.6× while speeding up.
  - A once-per-wheel-turn pulse (the magnet rate ÷ 23 magnet pairs) dips the sum to 0.7.
  - Every tone's pitch drifts by up to 6 cents: a smooth random wander, about 7 new targets a second.
  - Then a peaking filter at 1500 Hz, Q 1.5, −3 dB (the housing).
  - Level 0.1 speeding up, 0.05 holding speed and 0.008 coasting, each × `min(1, speed / 0.3)`.
- **Wheels:**
  - Rolling noise through a band-pass at `1800 × (0.7 + 0.3 × speed / 6)` Hz, Q 0.8, level `0.12 × (speed / 6)^1.2`.
  - Seam ticks: one per tile travelled while moving over 0.3 tiles/s. Each is a 50 ms burst of noise through a
    band-pass at 3200 Hz, Q 2, starting at `0.15 × (speed / 6) × 0.5` and decaying exponentially to silence within
    30 ms.
- **Bump:** impact = speed just before the stop ÷ 6, at least 0.15; level = 0.45 × impact.
  - Thud: a sine sweeping from 136 Hz (85 × 1.6) down to 85 Hz over 50 ms. It rises to the level in 4 ms, then
    decays with a 0.06 s time constant.
  - Rattle: noise through a band-pass at 1500 Hz, Q 3, starting at half the level and decaying with a 0.03 s time
    constant.
- **Master:** 0.6, so the loudest layer (the whiss while speeding up, 0.6 × 0.35 = 0.21) peaks about 13.5 dB under
  unity, below a voice.
- **Smoothing:** every level and pitch glides with a 0.05 s time constant, and a stopping sound fades for 5 time
  constants before its oscillators stop.

### When a bump plays

- **Own:** `stepRide` reports a head-on stop (the existing wall rule, speed → 0) as `ride.bump`, the speed before
  the stop, for that one step. Scraping makes no sound.
- **Own:** the bump plays only if the ride stopped from at least 1.5 tiles/s, and at most once per 0.3 s. Throttling
  into a wall rocks at a crawl, which would otherwise thud about 26 times a second.
- **Others:**
  - The server sends nothing while a rider stands still, so a stop shows as updates ceasing (1.8 update intervals
    with none).
  - It is a bump if the last stretch before it ran at 1.5 tiles/s or more. Braking ends slower than that.
  - A jump snapshot never counts.
  - At most one bump per 0.3 s.
  - The thud is scheduled for when the stop is drawn: the last snapshot's time plus the rider's draw delay.
- **Stepping off or leaving:** a rider's sound fades out before it is let go of. Its engine key is per ride, so a
  rider stepping straight back on gets a new sound that the old fade never touches.

## 5. Tests

- **The synth:**
  - the whiss's pitch never changes with speed;
  - the whine's four tones sit at ×1, ×2, ×2.22 and ×12 the magnet rate, drift, and pulse once a wheel turn;
  - the levels for each load match the table;
  - wheel level and pitch follow speed;
  - one seam tick per tile;
  - a bump makes one thud and one rattle and no ring;
  - a fade-out on stop.
- **The manager:**
  - the load is inferred from motion: speeding up, steady and slowing;
  - a sudden stop plays one bump;
  - braking and a portal jump don't;
  - the own bump comes from `ride.bump`.
- **`stepRide`:**
  - `ride.bump` is the speed before a head-on stop;
  - it is 0 on every other step, scraping included.

## 6. Left to the builder

How the synth is split across files.
