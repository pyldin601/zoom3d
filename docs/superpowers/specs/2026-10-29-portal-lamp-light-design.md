# Portal lamp light: the baked light follows the portals

Date: 2026-10-29. Status: draft for review. Builds on D27 ([portal doorways spec](2026-10-28-portal-doorways-design.md))
and D24 (lighting).

## 1. Intent

With portals on (D27), a doorway seen from its front shows another doorway's back side, but the lamp light around it is
still baked for the ordinary floor plan. Two things give the trick away:

- The floor and walls in front of doorway A glow with the lamps of the room physically behind A, a room that is not
  there any more: what shows through A is B's back side, which may be dark.
- The lamps of the room seen through A light nothing on A's side.

The fix: with portals on, the room's baked light follows the portals, so the light around a doorway matches what is
seen through it. Press Y and the light changes along with the space.

## 2. What it does

### 2.1 The rule: light follows sight

The space is one-way, so "what a spot sees" and "where a walker carrying a lamp would go" disagree. From A's front, A
shows B's back side. But light leaving B's back side towards B crosses B back→front, the ordinary way, and lands on B's
front, not at A.

**A spot is lit by the lamps it can see, the way it sees them** (agreed 2026-10-29).
- A sight line that crosses a doorway's plane front→back does not reach what is physically behind the doorway. It
  carries on from the destination's plane, exactly as a view ray does.
- A sight line that crosses back→front is ordinary.
- So the floor in front of A is lit by the lamps that are seen through A, and no longer by those physically behind it.

**The step at a window is accepted** (the user's choice, 2026-10-29, after trying both rules in a throwaway demo).
- Looking through A from its front, the light from lamps on the viewer's side ends at A's plane. Past it, B's back side
  has only its own light.
- The user's reason: light from the viewer's room cannot reach B's back side, because that room cannot be seen from
  B's back side.
- **The alternative, rejected:** join each doorway with its destination both ways. B's back side would also get the light
  of A's front side, so the light would carry on across the window. But B's back side would then glow from a room that
  cannot be seen from there: the same spill this work removes, only moved to the arrival side.

### 2.2 Lamp copies

The light calculation already works with straight sight lines from a spot to a lamp. With portals on, each lamp also
appears as a **copy** behind every doorway through which it can be seen:
- The copy is placed where the lamp appears through that portal: the lamp carried back through the portal's transform,
  the same image that `apparentPosition` finds for a person.
- A spot sees a copy only along a straight line that passes through that doorway's opening, front to back. The part
  before the plane must be clear of walls on the real map. The part after it, carried through the portal, must be clear
  of walls at the destination.
- The soft shadow at the doorway's edges (`seenShare` halving across the lamp's disc) works for copies unchanged. A
  doorway's frame cuts a copy's light the way a wall's edge cuts a lamp's.

Copies follow light **through one portal**. A lamp seen through two doorways in a row does not light this side *(our
call: drawing goes two deep, but a lamp two doorways away barely reaches; one level keeps the count of copies and the
calculation time down)*.

Copies are real entries in the room's lamp list while portals are on. So everything that reads the lamp list follows
the portals with no more work:
- the wall and floor **reflections** (the bake lists which lamps each spot reflects);
- the **lighting on people, the vacuum and the ball** (`directLight`), which must use the same portal-aware sight test
  per frame;
- the **object shadows** of lamps, as far as they already use the bake's sight shares (`floorLampSeen`).

### 2.3 Two calculations per room

- The plain light stays as it is today, calculated once per page (`bakeRoomLightingOnce`).
- The portals-on light depends on the room's wiring, which comes from the room id. So it is calculated **per room,
  while its lobby is open, at the latest on Join**, next to the plain one, in an idle moment (`roomLightingByRoom`).
  Nobody is walking yet then, so a few hundred milliseconds are not noticed *(the user picked this, approach A)*. In the
  Join click itself they would freeze the lobby and hold up the connection.
- **It is ready before it can be needed** *(our call)*. If the idle moment hasn't come by Join, it is calculated
  synchronously when the room is created, before the welcome is handled. So a room that is already in portal mode when
  someone joins, or a Y pressed early, always finds it ready, and there is no "not ready yet" state. A worker (§6) is
  only allowed if it keeps that guarantee, for example by holding the first room frame until the table arrives.
- The room keeps both. While portals are on, every pass in the frame uses the portals-on light: the main pass and every
  window pass. While they are off, every pass uses the plain light. A window pass draws the destination with the same
  table, so a doorway's far side is lit consistently with its near side.
- The swap on Y is **instant**, in the same frame the portals flip *(our call: space itself changes instantly, and a
  fade would light a room that is no longer there)*.

### 2.4 What stays as it is

- **Bounce light** (the soft fill, `bakeBounce`) is not recalculated for portals on. The portals-on table reuses the
  plain table's bounce array as it is *(our call: it is faint and spread over two tiles, so the error cannot be seen;
  reusing it costs nothing; a portal-aware fill would be a project of its own)*.
- **Ceiling lamp fixtures** are drawn where the real lamps hang. A copy is not a fixture: through a window, the
  destination's fixture is drawn by the window's own pass.
- **Unlit rooms** (`?lights=off`) and the flat mode have no lighting, so nothing changes there.
- The ray-traced spike renderer (D25) is out of scope, as it was for D27.

## 3. Goals, non-goals, anti-goals

**Goals:** with portals on, the light, reflections and lit people and objects around every doorway match what is seen
through it; Y swaps the light in the same frame as the space.

**Non-goals (part 2, later):**
- Moving shadows that cross a portal: a person or object beyond a doorway casting a shadow onto this side.
- Avatar glow through portals.
- Bounce light through portals.
- Lamp light through more than one portal.

**Anti-goals (failure even if it works):**
- Any pixel different, or any frame slower, with portals off. The `bench:walls` and `bench:sprites` pixel hashes must
  stay the same.
- A frame hitch on Y. The swap only changes which table is read.
- A seam where the main pass meets a window pass that comes from the two passes reading different tables or sampling
  differently. The step that rule §2.1 itself produces is expected.
- A visible hitch when entering a room. The calculation has to fit in the time the join already takes.

## 4. Constraints

- No allocations in the per-frame or per-column path (AGENTS.md). The `directLight` sight test with portals, and the
  reflections reading copies, are per-frame paths.
- **The 127-lamp limit has to grow.** Lamp lists store indices as signed bytes (`MAX_LAMPS = 127`). level1 has 37 lamps
  and 24 doorways, and there are about 200 lamp–doorway pairs within `LAMP_SIGHT` (16 tiles), counted 2026-10-29. So the
  copies alone can pass the limit.
- **Calculation time:** the plain calculation takes about 130 ms on level1 (bounce included, measured 2026-10-29). The
  portals-on one has more lamps and a costlier sight test. Its time is measured and recorded. If it is far beyond
  ~300 ms, the builder narrows which copies are made (§6) before anything else.
- **Memory:** two lighting tables per room, a few MB.
- Logic is test-first: the copy placement, the copy sight test, the lamp lists past 127, and `directLight` with portals.
  The look is checked by playing and by a bench pose in front of a doorway with portals on.
- Record the decision in `docs/open-decisions.md` as D28, and add a line to D27's known gaps pointing to it.

## 5. Approaches considered

- **A. Calculate the light a second time for portals on, for the whole map (chosen).** It is the same calculation with a
  portals switch: a portal-aware sight test plus lamp copies. The room keeps both results and Y swaps them.
  - Costs: one more calculation per room, while its lobby is open, double the light memory, and the lamp lists grow
    past 127.
  - Gains: no per-frame cost, one lighting layout, and everything that reads lamps follows for free.
- **B. Calculate once, then patch only around doorways.** Recalculate only the cells and wall samples whose sight lines
  cross a doorway, and keep them as a small patch that Y turns on.
  - Gains: faster and smaller.
  - Costs: a second lighting layout; every per-frame lookup asks "is this spot patched?"; seams are easy at patch edges.
  - Not chosen. Its idea of "only near doorways" stays available to speed up A's calculation (§6).

## 6. Left to the builder

Settled after the builder check *(our calls)*:
- Copies never show a ceiling fixture.
- `object-shadows.ts` falls back to a plain `seenShare` for lamps a cell doesn't list. With portals on, that fallback
  must use the portal-aware sight test and handle copies, or a copy would darken floor that is physically near it.
- `directLight` needs to know which portal a copy shines through, to run its sight test.

Open to the builder:

- **Which copies to make.** Only lamps that some spot on the doorway's front side could see through it, within
  `LAMP_SIGHT` of the plane, are worth a copy. The builder decides whether to prune copies that light nothing, and how.
- **How the lamp lists grow past 127:** `Int16Array`, or another layout. The lists' memory and the reflection tables
  (`reflectionColoursOf`, sized by lamp count) grow with it.
- **Where the copy sight test lives.** It probably belongs next to `apparentPosition`'s chain check in
  `packages/shared/src/portals/`. Whether the coarse lamp-sight table (`bakeLampSight`) needs it too, or can treat
  copies coarsely, is the builder's call.
- **Where the room keeps its two tables,** and how `describeScene` picks one: next to the wiring in `game/room.ts`, or
  in `room-lighting.ts`.
- **Whether the portals-on calculation runs in a worker** if it turns out too slow on the main thread.
