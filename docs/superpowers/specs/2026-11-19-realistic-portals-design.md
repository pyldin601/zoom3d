# Realistic portals: light goes the way walkers go

Date: 2026-11-19. Status: draft for review. Builds on D27 (portal doorways), D28 (portal lamp light), D29 (glow,
shimmer, hum) and the portal self-image spec.

## 1. Intent

Portals are one-way: a walker crossing doorway A front to back comes out of B (`A.to`) on its back side; crossing back
to front is an ordinary step. Today's view follows the walker's path, which means the light reaching an eye in front of
A has travelled *against* that rule, out of B and back through A. So from A's front you see B's far side.

The owner wants a second way to present portals, **realistic**, where light obeys exactly the walker's rule, as real
photons would. It is a per-person choice in the backtick console. The current look stays and is the default
(**classic**).

## 2. What a person sees and hears

Only while the room's portals are on. With portals off, or with classic chosen, nothing changes, pixel for pixel and
sound for sound.

- **From a doorway's front (the entrance) the doorway looks ordinary.** The eye sees the real room behind it, as with
  portals off: light from there crosses the plane back to front, which is ordinary. Stepping in still lands at the
  destination, so a walker going in vanishes at the plane.
- **From a doorway's back (the exit) it is a window onto its source's front room.** The source is the doorway whose
  `to` is this one; the wiring is one cycle (`sattoloCycle`), so each doorway has exactly one. Nothing of the room
  physically on the exit's front side shows: that light crosses the exit front to back and is carried off to the
  exit's own destination. People heading into the source walk toward the viewer and step out of the window.
- **Every doorway is both.** It is an entrance from its front and an exit from its back.
- **Lamp light follows the same rule (D28's "light follows sight", with realistic sight).** The space behind an exit
  is lit by the lamps of its source's front room; nothing beyond an entrance lights its front.
- **Sound follows it too.** Voices, the boombox, the vacuum, the ball and the hums are placed where they appear under
  the realistic rule, so a listener behind an exit hears the people approaching its source.
- **The pink (D29) moves to the window side.** The shimmer and rim are on what an exit shows; the glow spills on the
  exit's back side, cut at the plane; the hum is heard from the back side and not from the front. This is the owner's
  accepted default, and falls out of §3.
- **The walker's own crossing is a hard cut** *(a consequence of strict photons; the owner accepted it, 2026-11-19)*.
  Walking into an entrance shows the real room behind it right up to the plane, then the view jumps to the
  destination. Walking into an exit's window never reaches what it shows: that step is ordinary, into the exit's real
  front room. Classic crossings are seamless; realistic ones never are. No transition (fade, flash) is drawn.
- **The self-image and own label** follow the realistic rule: someone behind an exit can see themselves when the loop
  brings them round.

Discussed and rejected (2026-11-19, owner):

- A black entrance and an exit that adds both views: dramatic, but not physics. A black entrance needs a face that
  swallows light that walkers pass through; adding both views makes light out of nothing.
- An energy-conserving split (both views mixed to sum one): also rejected in favour of strict photons.

## 3. How: the same portals, turned round

**The realistic view is the classic machinery run on a swapped set.** For every portal take its normal reversed
(`nx, ny → −nx, −ny`) and its destination replaced by its source; `toDest`/`fromDest` are recomputed for the new pair
(the same rotation rule as `transformBetween`). In that set, a sight ray crossing a doorway's new front to back, which
is the real back to front, continues out of the source's new back, which is the real front: exactly §2.

- A pure function in `packages/shared/src/portals/wiring.ts`, say `photonPortals(classic: Portals): Portals`, shares
  `map` and `byTile` with the classic set (doorway indices don't change). Server and client compute it, never send it.
- **What takes which set:**
  - **The sight set** (the chosen look's): every renderer pass and window (`walls.ts`, `frame.ts`, `frame-eyes.ts`),
    the lamp table, portal glows and their shadow tables, lighter and headlight shadow fills, `apparentWorld`
    (labels, the face subscription's `facts`, sound placement), the hums, `placeOwnLabel` and `scene.self`.
  - **The real set** (always classic): walking (`LocalPlayer.walk`, `stepPlayer`, `stepRide`), `crossedPortal`, the
    ball's physics, mind, kicks and `holdSpot` (on both server and client, which must agree), and everything else on
    the server.
- In `game/room.ts`, today's one `portals()` splits in two: `portals()` stays the real set, and a new `sightPortals()`
  returns the classic or photon set by the console choice (null while portals are off). Every call site in the list
  above moves to `sightPortals()`.

## 4. The lamp light

- `createRoomLighting` gains a third table: `bakePortalLighting(plain, photonPortals(wiring), …)` and its own dark
  table (the blackout keeps that set's `portalGlowSeen`). About 270 + 20 ms.
- **Baked only when needed** *(our call)*: in an idle moment once realistic is the saved choice and a room's lobby is
  open, or right after the console switch when already in a room. Classic users never pay for it.
- **The look switches whole** *(our call)*: until the photon table is ready, the room keeps showing classic, so sight
  and light never disagree. A switch in a room takes effect when the bake lands (a frame stall of about 0.3 s, once).
- `RoomLighting.lighting(portalsOn, dark)` takes the look too, or returns per-look tables: left to the builder.

## 5. Who is near (server and client)

D27's `isNear` decides the fan-out tier (near every tick, far every 500 ms) and the client's interpolation delay.
The server doesn't know anyone's look, and the look must stay off the wire *(owner, 2026-11-19)*.

- **Near under either rule:** a pair is near if it is near in a straight line, through the classic set, or through the
  photon set. One shared function used by both `fanout.ts` and `remote-world.ts`'s `nearTier`, so server and client
  still agree (D23). Classic viewers get a few extra fast updates; nothing is drawn differently for them.
- **Measured** (2026-11-19, throwaway patch of `selectBatch`, `pnpm bench:tick`, two runs each, portals on):
  4 people 0.21 ms → 0.28–0.33 ms; 100 people mean 5.8–6.2 ms → 8.3–8.4 ms, p99 6.5–7.0 ms → 9.0–9.3 ms of the 66 ms
  tick. Portals off is untouched. The builder re-measures with the real code and records it in the decision.
- **Budget** *(our call)*: if the real code's mean at 100 people goes past 12 ms, cut the union's cost before merging.
  One lead: photon-near from A to B should be classic-near from B to A, so one apparent-position search per pair may
  answer both. Under the budget, the plain second search stays.
- **No protocol change.** `PROTOCOL_VERSION` stays.

## 6. The console

- `RenderSettings` (`ui/render-settings.ts`) gains `portals: 'classic' | 'realistic'`, default `'classic'`, checked
  on its own in `normalizeRenderSettings` so old saved settings fall back to classic. Same key, `zoom3d.render.v1`.
- A row under the lighting mode in the console's Renderer column: *Portals: Classic / Realistic*. Changing it applies
  live (subject to §4's bake).
- Works with portals off too; it just shows nothing until someone presses Y.
- The touch tray's one renderer button keeps cycling only the lighting mode *(our call)*, so touch users stay on
  classic: the console opens only with the backtick key.

## 7. Goals, non-goals, anti-goals

- **Goal:** with realistic chosen, a viewer can work out the maze by light alone the photon way: entrances look like
  plain openings, exits show who is coming.
- **Non-goals:** a per-room look; sending the look; any change to how anything moves; lamp light through two portals,
  moving shadows or bounce light through portals (still D28's gaps, in both looks); an analytics event for the choice.
- **Anti-goals:** classic changing in any way (the `bench:walls`/`bench:sprites` hashes, classic and portals-off, must
  stay as they are); sight and light disagreeing for a moment while the look switches; server and client disagreeing on
  near.

## 8. Tests

- `photonPortals`: swapping twice gives the classic set back; each portal's `to` is its classic source; a point carried
  through a photon portal and back lands where it started.
- A sight ray in `test-portals.ts`'s hall: from the classic front it hits the real room's wall; from the back it comes
  out of the source's front.
- `isNear` under either rule: a pair seen only through the photon set is near.
- `normalizeRenderSettings` defaults and keeps `portals`.
- `room` / `room-loop`: the real set drives walking and the ball, the sight set drives `scene.portals` and hums.
- Pixel hashes: classic unchanged; add a realistic doorway pose to `bench:walls` for later refactors.
- E2E is optional; the look is verified by eye in game.

## 9. Left to the builder

- The function's name, and how `RoomLighting` exposes the third table.
- Whether the photon set is computed in `wirePortals`'s caller or cached alongside the classic set.
- The console row's exact wording and control.
- Re-measuring §5 and the frame cost of a realistic doorway frame, and recording both in D38.
