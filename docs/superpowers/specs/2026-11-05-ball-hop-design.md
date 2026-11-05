# Ball hop: a drawn jump for kicks and play

Follows the living ball spec (`2026-11-02-living-ball-design.md`, D33), which said "no jumps for now". The owner has now
asked for them.

## Why

The ball is a puppy, and a jump shows how it feels in a way rolling can't. Kicking it should look more physical too.

## Goals

- A kicked ball hops once, for everyone in the room, whoever kicked it.
- A playing ball hops again and again for as long as it is playing, on top of its dashes.
- Its lamp shadow leaves the floor point under it and its floor image drops away, so it reads as a jump and not a slide.

## Non-goals

- A scared ball doesn't hop (owner): it keeps its tremble, unchanged.
- No hop in any other mood.
- No flying over people or being kicked in the air: a ball in mid-air collides exactly as on the floor.
- No hop sound in this first cut (builder's call, easy to add after playing it).

## Anti-goals

- No server, protocol, snapshot or `stepBall` change: where the ball is stays exactly what it is today.
- A lift of 0 draws pixel for pixel as today: the vacuum and a resting ball keep their `pnpm bench:sprites` and
  `pnpm bench:walls` hashes.
- No allocations per frame.

## Approaches

1. **Drawn only (chosen by the owner):** a height that lives in the client, like the tremble. Small and safe, but players'
   hops aren't in step, and a ball in mid-air can still hit someone.
2. **Real height:** in the shared physics, the protocol and the prediction. It could clear people and be kicked in the air,
   but it is far more work and runs into the ball rewind work on the same code.

## Design

- **The hop (`game/ball-hop.ts`, pure, test first):** a height and upward speed under gravity, stepped each frame. A kick
  sets the upward speed. While the mood is `playing` and the ball is on the floor, it leaves again after a short gap. Being
  a simulation, nothing snaps: a kick in mid-air just throws it up again, and a mood change lets it land first.
- **Triggers:** the local kick in `room.ts`, and the `kick` event from the server for other people's, skipping the local
  player's own echo as `object-sounds.ts` does. Mood is already on the wire.
- **Drawing:** `VoxelInstance` gains `lift` (tiles, required, so its shape stays one). `projectFaces` adds it to each
  corner's height, which also lowers the mirrored image. Lamp and glow light are sampled at the lifted height. Every place
  that builds or copies an instance sets or carries it, portal windows included.
- **Shadows (`object-shadows.ts`):** `blocked` and `shadowReach` take the lift into account, so the shadow detaches and
  moves away from the ball as it rises. A column counts as solid from `lift` to `lift + top`, not from the floor. Slightly
  too much shadow from under the sphere's curve is accepted.
- **Stale comment:** "the eye-height camera never sees a bottom" in `voxels.ts` stops being true and gets fixed.

## Starting values, for the owner to tune by playing

| | Height | Gap |
|---|---|---|
| Kick | 0.35 tiles | one hop |
| Playing | 0.15 tiles | 0.15 s between hops |

Gravity sets how long a hop lasts: about 14 tiles/s² gives roughly 0.45 s for a kick and 0.3 s for a play hop (3 looked like the moon). A bottom face
shows only once it is above the eye at 0.5, so the ball's underside shows just near the top of a kick hop. The bottom faces
already exist for the mirror.

## Left to the builder

- Where the hop state lives and how `remote-world.ts` reads it.
- A dev helper, if `__game.forceBallMood('playing')` isn't enough to judge it.
- A new entry in `docs/open-decisions.md`, and a line in `AGENTS.md`'s living ball notes.

## Checks

Failing tests first for the hop, for projection at a lift, and for `blocked` with a lift. The bench hashes above must stay
the same. Then the owner judges the look in the game, in lit and dark rooms.
