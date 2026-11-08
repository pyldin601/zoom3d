# Scooter headlight design

Date: 2026-11-07. Status: approved and built (2026-11-07). Extends D36 (kick scooters, then electric) and reuses D31 (the lighter).

## Intent

A ridden scooter's headlight lights the room ahead of its rider. Today the lamp on the stem is a glowing voxel that
lights nothing, parked or ridden. The owner wants the light to show when a scooter is engaged, with walls casting
shadows the way they do for the lighter.

## Goals

- While someone rides, a cone of light falls ahead of the scooter, along its heading. It lights floor, walls, people,
  the vacuum, the ball and parked scooters, as the lighter does.
- Walls block it and it never goes round corners, using lighter-style shadow tables (owner).
- Everyone sees it: the rider and the people around them.
- The stem lamp glows while ridden and is dark while parked, so you can see from a distance which scooters are in use
  (builder's proposal, accepted with approach 1).

## Non-goals

These were all left out for the lighter too, and each would be a project of its own:

- shadows cast by people or objects;
- reflections;
- light through a portal's destination;
- light in unlit or flat rooms.

## Approaches

1. **Chosen (owner, 2026-11-07): a cone glow with lighter-style wall shadows.** This brings back the `Glow` cone that
   commit `907b48f` removed: 35° each way, with the last 10° fading out. It measured 2.26 ms a frame against 2.40 ms
   all-round (D31). It reads as a real headlight, and the code was tested once already.
2. A half-circle: the same glow, cut flat behind the stem with the existing `cut` plane. It needs no revived code,
   but it's a wide wash rather than a beam.
3. All-round, exactly like the lighter. It's the simplest, but it lights behind the rider too, so it doesn't read as
   a headlight.

## Design

- **Source:** one headlight per rider, both the riders others see (`remote-world.ts`) and the local player while
  riding (`local-player.ts`).
  - It sits at the lamp, a little ahead of the rider along the scooter's heading.
  - For the local player that heading is `pose.angle`, not `eye()`. Turning the head does not move the beam.
  - It goes into the frame alongside the lighters (`frame.ts`, `gatherGlows`), only in a lit room.
- **Glow:** a `Glow` with the cone restored.
  - Starting values, to be tuned by riding: reach 5 tiles, cone 35° each way with the last 10° fading, a neutral warm
    white close to the lamp voxel's colour, and no flicker.
  - Strength starts near the lighter's 1.5.
- **Shadows:**
  - Each rider has a pooled `GlowShadow`, filled with `seenShare` like the lighter's. It is refilled only when the
    lamp enters another floor cell or the portals switch, never on a turn.
  - At full speed that's about 48 refills a second per rider, at about 0.13 ms each. `pnpm bench:walls` gets a
    riding case.
  - If a refill turns out too costly at speed, the builder may refill per tile instead and record it.
- **The lamp voxel:**
  - The parked model's lamp is a plain, unlit colour.
  - A ridden scooter uses a second model whose lamp glows as it does today.
- **Unchanged:** every scene with no rider draws pixel for pixel as before. The `bench:walls` and `bench:sprites`
  hashes for scenes without riders stay the same.

## Left to the builder

- The exact lamp offset and the light's height.
- The colour and strength, by eye in the game.
- Whether the lighter and the headlight share one pooled glow source type or keep two.
