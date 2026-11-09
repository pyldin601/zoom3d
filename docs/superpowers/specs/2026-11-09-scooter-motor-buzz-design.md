# Scooter motor buzz (design)

A small change to the scooter sound (spec [2026-11-07-scooter-sound-design.md](2026-11-07-scooter-sound-design.md),
decision D36).

## Intent

The owner, 2026-11-09: the scooter "is too clear: it sounds too FM-ish". The motor should sound like a physical motor
under strain, with a rough electric buzz, not like a synth.

Why it sounds FM-ish today (`apps/web/src/audio/scooter-sound.ts`): every tone is a pure sine; the whine's loudest tone
sits at a non-integer 2.22× the magnet rate, which is how FM bells are made; the whine's pitch wanders ±6 cents; and
nothing colours it but a 3 dB dip at 1500 Hz.

## Goals

- The whine gains harmonics and roughness that grow with load: most when pulling, less when cruising, nearly clean
  when coasting.
- Same for every rider's scooter: the local player's own and other riders' (one synth, `createScooterSound`).

## Non-goals

- Frame resonances (deck, stem, housing ringing): the owner chose the buzz over them.
- The PWM whiss, wheels, seam ticks and bumps: unchanged.

## Anti-goals

- The hiss coming back: no added noise.
- Louder overall: the buzz changes the timbre; the whine's level per load stays the owner's.

## Approaches

1. **Distortion that grows with load** (chosen by the owner): a soft clipper on the whine. Harmonics at whole-number
   multiples of each tone, plus intermodulation of the off-ratio slot tone with the others for grit. One node per
   scooter, and it follows the throttle.
2. A six-step drive waveform instead of sines: authentic fixed harmonics (5th, 7th, 11th, 13th), but the same at every
   load.
3. Noise pulsed at the magnet rate: raspy, but reads as noise and would bring the hiss back.

## Design

- Whine path today: tones → lower/upper buses → once-a-turn pulse → housing dip → whine level → master.
- New, between the pulse and the housing dip: a drive gain → a `WaveShaperNode` (a smooth tanh-like curve,
  `oversample: '4x'` against aliasing) → a lowpass (the buzz's tone) → a makeup gain, so the whine's loudness stays
  set by `WHINE_LEVEL` and the drive only changes how rough it is.
- The drive per load (pulling, cruising, coasting) glides like every other level (`GLIDE_S`), so throttle changes
  never click.
- **Tuning first:** a throwaway listening page (like the Scooter Sound Bench the owner tuned the sound on) plays the
  synth with sliders for the drive per load, the lowpass, the makeup, and a switch to keep or drop the 2.22× slot tone.
  The owner's values go into the code; the page isn't kept in the repo.
  *Done 2026-11-09:* drive 14, 5 and 0 dB; hardness 0.28; asymmetry 0.19; lowpass 2310 Hz; makeup −5.5 dB; slot tone
  kept at 0.24 (was 0.3). Wheels: 900 ticks/s, swell 0.35, level 0.6, modes 190 Hz Q 9 × 0.6, 460 Hz Q 7 × 0.35,
  1150 Hz Q 5 × 0.15 (the page's starting values, which the owner kept).

## Rolling wheels (added 2026-11-09)

The owner: the rolling "sounds like white noise; it doesn't sound like rolling wheels". It is: steady white noise in
one soft band at 1.3–1.8 kHz. Real rolling is mostly low (100–400 Hz), swells once a wheel turn (no wheel is round),
and is made of many tiny ticks from tread and floor texture, more the faster it rolls.

- **Approaches:** (1) grains into wheel modes, chosen by the owner: speed sets how many tiny random ticks fire a
  second, and each strikes a few resonances (wheel core, deck), the whole swelling once a turn; the usual way
  physical rolling is synthesised. (2) Rumble and rhythm: the noise moved low, with the swell and some grit; cheaper,
  but still noise underneath.
- **Builder's call:** hard polyurethane wheels on a smooth indoor floor.
- **Grains without per-frame work:** one looped buffer of sparse random ticks (random heights, Poisson spacing) is
  built once per sound and played at a rate that follows speed, so the tick rate scales with speed and nothing is
  scheduled per frame. The ticks go through three resonant band-passes in parallel (the modes), then the once-a-turn
  swell (magnet rate ÷ 23, like the whine's pulse), then the wheel level by speed.
- Seam ticks and bumps are unchanged. The old white-noise roll goes.
- Tuned on the same listening page, with an A/B against the old wheels; its values join the motor buzz's.

## Left to the builder

- The exact curve shape and the sliders' ranges, and the defaults the page starts from.
- Tests: the drive per load and its glide, the wiring (shaper between pulse and housing), and the slot tone kept or
  dropped as the owner decides.
