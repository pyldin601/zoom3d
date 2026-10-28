# Portal doorways: non-Euclidean space on Y

Date: 2026-10-28. Status: draft for review.

## 1. Intent

Anyone in a room presses **Y** and the room's space bends for everyone at once: doorways become one-way portals, and
the familiar floor plan turns into a maze that has to be learnt. Press Y again and space is ordinary again. It is a
shared toy and a puzzle: people explore it together, and because the wiring is fixed for the room, they can learn it
and tell each other the way ("back through the wooden door, then the blue one").

## 2. What it does

### 2.1 The mode

- One flag per room, `portals`, off when the room opens. The server owns it, like the vacuum and the ball.
- Y (any person in the room, connected) asks the server to flip it; the server flips it and tells everyone, the asker
  included. Joiners and resumers get the current value in their welcome. Nobody's world ever disagrees with the
  server's for longer than one message.
- Everyone sees a short notice when it changes: "Portals on" / "Portals off". *(Our call: a sudden change needs an
  explanation.)*
- The flag survives a server restart through the state file, like the vacuum. *(Our call.)*

### 2.2 Doorways

- A **doorway** is a floor tile with walls on exactly two opposite sides and floor on the other two. It passes either
  north–south or west–east. level1 has 24 of them (counted 2026-10-28); 3-tile corridors and open room sides are not
  doorways and never bend.
- The doorway's **plane** is the line through its tile's centre, across the passage, one tile wide, wall to wall.
- Each doorway has a **front** side and a **back** side. Crossing its plane from back to front is ordinary.
  Crossing it from front to back is a portal jump.

### 2.3 Wiring

- Per room, each doorway gets a random front and a random destination doorway. The destinations are a derangement (a
  permutation with no fixed points): every doorway leads to exactly one other doorway, and every doorway is the
  destination of exactly one. *(Our call: no dead ends, no doorway leads to itself.)*
- The wiring is a pure function of the map and the room id (seeded RNG, `packages/shared/src/random.ts`), so the
  server and every client compute the same wiring locally. It is never sent over the wire, and it stays the same for
  as long as the room exists (and after a restart).
- A portal jump at doorway A (front→back) puts the walker on the **back** side of A's destination B, as though they had
  just crossed B front→back too, so B's plane is behind them. The mapping is rigid: A's plane maps onto B's plane,
  A's front→back direction onto B's front→back direction, and the offset along the plane is kept. It is a rotation
  and translation (a multiple of 90°), never a mirror image. If they turn round and walk through B, B is crossed
  back→front: an ordinary door, onto B's front side, not back to A. That one-way-ness is the puzzle.
- Nobody can be trapped: crossing a plane back→front always works, and toggling the mode never moves anyone (a
  position is never "inside" a plane).

### 2.4 Everything obeys the same rule

One portal-aware geometry module in `packages/shared` replaces the Euclidean primitives while the mode is on, so the
client, the server, bots and objects all agree:

| Today | With portals on |
|---|---|
| `castRay` | a ray crossing a doorway plane front→back continues from the destination's plane, with its direction rotated, and reports the transform it went through |
| `moveWithCollision` / `stepPlayer` | a step crossing a plane front→back comes out at the destination, with its angle rotated |
| `hasLineOfSight` | a straight segment crossing a plane front→back is not a line of sight; a line of sight may pass through portals the way rays do |
| straight-line distance | see 2.6 |

- **Walkers, bots and the ball** step through portals. The ball's velocity rotates with it. Client-side ball prediction
  uses the same step, so the local ball and the server's agree.
- **The vacuum** steps through portals too. Its navigation (`objects/vacuum/nav.ts`) plans on the Euclidean map; see
  §6, open for the builder.
- **Contacts work through portals.** *(Our call.)* The ball's push from bodies, the kick's reach and the vacuum's
  bump all measure the offset between two things through at most one portal (a shared "relative offset" helper, the
  same one 2.6 builds on), so dribbling carries on through a doorway and a person standing in one still stops the
  vacuum. The server sims and the client's ball prediction use the same helper, so they still agree.
- **The server's movement check** (`protocol/movecheck.ts`) accepts a jump that a portal explains, and still rejects
  anything else. For one second after a flip it accepts a move that either mode explains, so a move made just
  before the flip arrived is never corrected. *(Our call: no wire change, and a second of leniency is cheap.)*
- **Interpolation never slides across a jump.** A peer, bot, ball or vacuum whose two successive poses are joined
  through a portal is drawn going through the doorway and coming out of the other one, never gliding across the map.
  The simplest way that keeps this: snap at the jump.

### 2.5 Drawing (approach A, chosen)

The room is drawn again from a **virtual eye** for each portal on screen:

- The main pass draws as today, except that a doorway seen from its front is a **window**: its columns, where it is
  nearer than the wall behind, record the portal and the plane's per-column depth.
- For each window, the same passes run again for just those columns, from the eye moved through the portal's
  transform, with a per-column **near limit** at the plane's depth. Nothing nearer than the plane is drawn in that
  pass, so the floor and ceiling between the eye and the doorway stay from the main pass.
- Every pass takes the column window and the near limit: walls, floor and ceiling (including lamp and glow
  lighting, which are world-space and so come out right at the destination), voxel objects and their lamp shadows,
  people's discs and shadows, and the floor mirror. Anything drawn through these passes later shows up through
  portals without more work.
- **Recursion:** a window seen through a window is drawn the same way, up to a depth of 2. Past that, the window
  is filled with black. *(Our call: cost is bounded, and level1's doorways rarely line up three deep.)*
- **Per-frame budget:** no allocations in the per-frame or per-column path, as today. Scratch for windows is sized
  when the frame's size changes. Cost has to stay inside today's frame time in the common case (one or two doorways
  on screen), measured with `pnpm bench:walls` and `pnpm bench:sprites`. With portals off, frames are pixel-identical
  to today (bench pixel hashes).
- **Faces:** `renderSprites`' `facts` count a person seen through a portal like a person seen directly, so their face
  gets subscribed at the right size.
- **Labels:** a name label follows the person where they are drawn, so someone seen through a portal is labelled at
  the doorway they're seen through.
- **Automap:** unchanged, the plain map. *(Non-goal: no wiring is shown.)*
- The ray-traced spike renderer (D25) is out of scope.

### 2.6 Distance, sound and fan-out (our call)

The user picked A for drawing; the following was recommended and not objected to:

- One shared function gives, from a listener to a target, the target's **apparent position**: either the target
  itself, or the target carried back through a chain of up to two portals, the same depth drawing uses. A chain
  only counts when the straight segment from the listener to that apparent position really passes through each
  doorway's opening, front to back, in order. Among those, the nearest wins, preferring lines of sight in the 2.4
  sense. With none, it is the target's real position, with the usual occlusion. *(Our call: a doorway that isn't
  on the way never makes someone sound close, and drawing and hearing agree to the same depth.)* Distance, pan
  and occlusion all use it. Someone just beyond a portal sounds near and comes from the doorway.
- Cost: the server runs it for every pair on every 66 ms tick. Only doorways whose front faces the listener and
  whose opening lies within the near range (16 tiles) are tried, and the second level only from those. With portals
  on, the 100-bot load test (`/?bots=100`) is run again, and the tick has to stay inside its budget.
- The audio engine (`audio/engine.ts`), face subscription interest (`media/interest.ts`) and the server's fan-out
  tiers (`fanout.ts`, near ≤ 16 tiles) all use it, so a person seen through a portal sounds near, moves smoothly and
  sends their face.
- With portals off it equals today's straight-line distance and line of sight exactly.

## 3. Wire and state

- Client → server: `{ type: 'portals' }` toggles. Rate-limited like other room actions (at most one toggle a second
  per room is honoured), so mashing Y can't strobe the room.
- Server → client: `{ type: 'portals'; on: boolean }` to everyone, and `portals: boolean` in `welcome`.
- `PROTOCOL_VERSION` 3 → 4.
- Snapshot: the per-room flag is added to `LobbySnapshot` with a default of off when missing. Whether that needs a
  version bump follows the existing rule in AGENTS.md (it shouldn't, if `parse` defaults it).
- Telemetry: an `AnalyticsEvent` for the toggle (no room id, per the privacy rules). Nothing else.

## 4. Goals, non-goals, anti-goals

**Goals:** a room-wide Y that turns every doorway into a one-way portal; a wiring that is fixed per room and the same
for everyone; drawing, walking, sound, faces, bots, ball and vacuum all agreeing on it.

**Non-goals:** wider openings bending; hand-authored or edited wiring; showing the wiring anywhere; a touch control
(Y is keyboard only, so phones follow whatever the room is in); curved (hyperbolic, spherical) space; the ray-traced
renderer.

**Anti-goals (would be a failure even if it works):**
- Clients disagreeing about where someone is, or the server correcting people who walked through a portal.
- People gliding across the map when someone goes through a portal.
- A face or voice that is visible through a portal but distant-sounding, or stuttering at the far fan-out rate.
- Anything slower, or any pixel different, with portals off.
- Anyone getting stuck: in a wall, in a doorway, or somewhere they can't walk out of.

## 5. Constraints

- No allocations in the per-frame or per-column hot path (AGENTS.md).
- Logic is test-first: doorway detection, the wiring, transforms, the portal-aware ray, step and line of sight,
  apparent position, movecheck, the protocol messages and the lobby flag. Rendering is checked by the benches, the
  pixel hashes and by playing; one Playwright spec covers Y flipping the mode for a second tab.
- Record the decision in `docs/open-decisions.md` as D27.

## 6. Approaches considered

- **A. Draw again from a virtual eye per portal (chosen).** Every pass takes a column window and a near limit; a
  portal on screen is a re-run of the same passes from the transformed eye. Costs: an extra partial pass per visible
  portal, a recursion limit, and the window/near-limit plumbing through every pass (the floor mirror's full-frame
  blur is the fiddliest). Gains: everything drawn, now and later, shows through portals for free.
- **B. Bend each ray.** `castRay` jumps and continues; each pass reads per-column "beyond the portal" transforms
  (floor rows past the crossing, sprites at apparent positions, shadows, mirror). Less redundant work, but portal
  logic in every pass and in everything added later. Not chosen.
- **Distance:** shortest through one portal (chosen, above) versus keeping straight-line distance on the map
  (simpler, but people seen through a portal would sound far and step at the far fan-out rate).

## 7. Left to the builder

- The vacuum's navigation with portals on: replan when a jump surprises it, or keep it out of doorways' front→back
  crossings. Either way it must keep cleaning and still find its dock.
- How interpolation spots a jump (a flag from the shared step, or "the segment crossed a plane front→back"), and
  which mode it judges two poses under when a flip falls between them (either explaining it is enough).
- How the notice is shown (whatever the room already uses for short messages).
- Window bookkeeping: how a window's columns, plane depths and transform are stored without allocation, and how the
  floor mirror's blur is confined to a window.
