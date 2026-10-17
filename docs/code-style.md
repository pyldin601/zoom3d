# Code style

How code in this repo should read. Formatting is Biome's job (`biome.json`: 120 columns, single quotes, semicolons,
`es5` trailing commas, braced `if`/`else`/`for`/`while` bodies); this page covers what a formatter can't check.

**The rule above the others: the code explains itself.** Names, types and the shape of functions say what the code
does. A comment is left only for what they can't say, which is nearly always *why*. The yardstick: a developer who has
never seen the module follows it top to bottom by reading names alone, and dives into a detail by following one name
down a level. The robot vacuum (`packages/shared/src/objects/vacuum/`) and the lobby (`apps/server/src/lobby.ts`)
follow it.

Code written before this rule (decision D10, 2026-10-17) still carries comments that a name could replace. Improve it
as you touch it, in readability refactors of their own (see Refactoring).

## Before writing a comment

Try these first, in this order, and write the comment only if none of them can carry what you meant to say:

1. **Rename.** The variable, function or constant says it: `distanceToWall`, `BUMP_PAUSE_S`, `selfDisc`.
2. **Extract a named function.** A block with a comment over it becomes a call. `// cast the ray, fill the z-buffer`
   above ten lines becomes `castColumn(fb, map, p, lm, col)`.
3. **Name the condition.** `inRoom()`, not `session?.status() === 'open'` at every use;
   `outOfView(g.x, g.y, cellsReach)`, not three inequalities inline.
4. **Name the value.** An explaining variable or constant, not a magic number with a note beside it:
   `const cellsReach = ((span + 1) * Math.SQRT2) / FLOOR_SUB`, `DECAY_60_DB`.
5. **Use a type.** A tagged union for states that exclude each other, `null` for absence, one named object for things
   that travel together (see State, Functions).

## Comments

- **A comment says why**, in one of four kinds:
  - a constraint the code can't show (`// Chrome only feeds WebRTC audio into Web Audio while the stream plays`);
  - a measurement that fixed a shape (`// SIDE_SHADE as a literal: read from the constant, this loop measured 3%
    slower`);
  - a decision and where it was made (`// The canvas track is always sent (lobby spec §4.3)`);
  - a fact about the maths a reader can't see (`// On the y-down map (-fy, fx) is the robot's right`).
- **Never what the next line does.** Once a name says what a comment said, delete the comment.
- **A module header is one to three lines**: the module's job, its spec, whether it is pure, its state model if it
  has one. Not a tour of the implementation: the function names are the tour.
- **A doc comment earns its place** by saying what the name and the type can't: a unit not in the name, a range
  (`0..1`), ownership (`returns a reused object: read it before the next call`), a side effect, an invariant.
  `/** The player's name. */ name: string` is noise; delete it.
- **Section comments** (`// Wall columns.`) are signposts in a long file. A file that needs many wants splitting.
- **A stale comment is a bug.** Change it with the code, or better, remove the need for it.

## Names

- **Say what it is, with its unit.** `PASS_DISTANCE`, `AIM_TOLERANCE`, `BUMP_PAUSE_S`, `FRONT_MIN_COS`, not `PASS`,
  `AIM`, `FRONT`. Times end in `_S` or `_MS`; other units go in the name where they fit (`_PX`, `_TILES`, `_RAD`),
  else in a one-line doc comment.
- **Functions that act are verbs** (`planLeg`, `startLeg`, `expirePeer`, `drawWallColumn`); **queries are nouns or
  questions** (`nearestTile`, `personInFront`, `bodyFits`, `outOfView`).
- **A stage is named for what it produces or draws**, so a caller reads as the steps: `stepYou`,
  `placeEveryoneElse`, `drawRoom`, `drawPeopleAndObjects`, `drawWhatYouHold`.
- **No near-synonyms side by side.** `phase` and `mode` on one object made readers guess which was which; the vacuum
  now has `phase` (its goal) and `activity` (what it does this step).
- **No terse helpers.** `wrap` → `normalizeAngle`, `turnTo` → `shortestTurn` (it returns a difference, it doesn't
  turn), `same` → `samePoint`, `clamp` → `clearOfWalls` (it does more than clamp), `fresh` → `initialState`.

## State

- **One field, one meaning.** States that exclude each other are a tagged union, not a mode plus a counter shared
  between modes:

  ```ts
  activity: { kind: 'move' } | { kind: 'scan'; radiansLeft: number } | { kind: 'pause'; secondsLeft: number };
  ```

- **Absence is `null`**, not a sentinel: `lastBump: Point | null`, not `bumpX = NaN`.
- **State changes are explicit.** A branch that changes state and then falls through into another branch gets split
  (`planCleaning` returns false, then `planLeg` switches to searching).

## Arrays and casts

- **Read with `.at(i)`** and handle `undefined`; never `arr[i] as T`. Writes still use brackets (`dist[next] = …`).
  Careful: `.at(-1)` is the last element, so bounds-check computed indices before reading.
- **No `as` casts to silence `undefined`.** Handle it, or in tests use `defined(value, 'what')` from the module's
  `test-helpers.ts`, which throws with a readable message.
- **Iterate instead of indexing** where you can: `for (const [i, p] of ring.entries())`,
  `for (const [index, steps] of queue)` (a `for…of` also visits entries pushed during the loop, so an array works as
  a FIFO queue).
- Hot paths are the exception to weigh (see below).

## Functions

- **Read top-down.** A function reads as a list of named steps at one level of detail, one call each: the room
  loop's `frame()` (`game/room-loop.ts`) is `stepYou` → `placeEveryoneElse` → `describeScene` → `renderView` →
  `renderHud`. Following a name takes you one level down. Don't
  mix levels: a loop over pixels doesn't sit beside calls to whole stages; it goes into a stage of its own.
- **A step function dispatches; each stage is a named function.** `stepVacuum` is a switch over `stepPause`,
  `stepScan` and `stepMove`; `Lobby.join` reads as check → resume → admit. Aim for functions that fit on one screen
  (~30 lines); past that, look for the stages hiding inside.
- **Name repeated tails.** Two branches ending in the same three lines get a helper (`startLeg`).
- **Long positional argument lists are a smell.** Past four, group what travels together into one named type (a
  view, a scene, options) or split the function.

## Hot paths

Per-frame and per-pixel code (the renderer, the audio update) keeps the loop shapes it was measured in. There,
readability comes from well-named locals and stages around the loop, not from calls inside it:

- **Extract a helper inside a hot loop only if V8 inlines it** (small, few call sites) and `pnpm bench:walls` /
  `pnpm bench:sprites` show no cost, with the pixel hashes unchanged.
- **Say why when a shape is kept for speed**: `reflection()` stays under V8's inlining limit, a constant is a literal
  because reading it measured slower. That is the kind of comment this page keeps.
- **No allocation per frame** (AGENTS.md): reuse objects, and write arrays by index and trim them after, since V8
  drops an array's storage at `length = 0`.

## Modules

- **Don't leak data layout.** `nav.distances(from)` returns a lookup `(tile) => number`, so callers never learn that
  the distances live in a `ty * width + tx` array.
- **Export only what other modules use.** Tuning constants used by one file stay private to it.
- **A self-contained simulation gets its own folder** with its tests and test helpers: `objects/vacuum/`.
- **File order:** header, imports, constants, types, small pure helpers, the public API, then private stages in the
  order they are called, so the file reads in the order the code runs.

## Refactoring

- **A readability refactor changes no behaviour, and proves it.** Run the tests before and after; for a simulation,
  also hash a long seeded run (poses and events every step) before and after, and expect the same hash; for the
  renderer, the `bench:walls` and `bench:sprites` pixel hashes.
- **Turning comments into names is a readability refactor.** It follows the same rules.
- Keep the refactor in its own commit, apart from behaviour changes.
