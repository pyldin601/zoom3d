# Code style

How code in this repo should read. Formatting is Biome's job (`biome.json`: 120 columns, single quotes, semicolons,
`es5` trailing commas, braced `if`/`else`/`for`/`while` bodies); this page covers what a formatter can't check. The
yardstick: a developer who has never seen the module can follow it top to bottom without keeping a glossary in their
head. The robot vacuum (`apps/server/src/objects/vacuum/`) and the lobby (`apps/server/src/lobby.ts`) follow it.

## Names

- **Say what it is, with its unit.** `PASS_DISTANCE`, `AIM_TOLERANCE`, `BUMP_PAUSE_S`, `FRONT_MIN_COS`, not `PASS`,
  `AIM`, `FRONT`. Time constants end in `_S` or `_MS`; distances and angles say tiles or radians in their doc comment.
- **Functions that act are verbs** (`planLeg`, `startLeg`, `expirePeer`); **queries are nouns or questions**
  (`nearestTile`, `personInFront`, `bodyFits`).
- **No near-synonyms side by side.** `phase` and `mode` on one object made readers guess which was which; the vacuum
  now has `phase` (its goal) and `activity` (what it does this step), and the module header says so.
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
  (`planCleaning` returns false, then `planLeg` switches to searching with a comment saying why).

## Arrays and casts

- **Read with `.at(i)`** and handle `undefined`; never `arr[i] as T`. Writes still use brackets (`dist[next] = …`).
  Careful: `.at(-1)` is the last element, so bounds-check computed indices before reading.
- **No `as` casts to silence `undefined`.** Handle it, or in tests use `defined(value, 'what')` from the module's
  `test-helpers.ts`, which throws with a readable message.
- **Iterate instead of indexing** where you can: `for (const [i, p] of ring.entries())`,
  `for (const [index, steps] of queue)` (a `for…of` also visits entries pushed during the loop, so an array works as
  a FIFO queue).
- Renderer per-frame/per-column hot paths are the exception to weigh: measure before swapping indexing there.

## Functions

- **A step function dispatches; each stage is a named function.** `stepVacuum` is a switch over `stepPause`,
  `stepScan` and `stepMove`; `Lobby.join` reads as check → resume → admit. Aim for functions that fit on one screen
  (~30 lines); past that, look for the stages hiding inside.
- **Name repeated tails.** Two branches ending in the same three lines get a helper (`startLeg`).
- **Long positional argument lists are a smell.** Past four, consider an options object or splitting the function.

## Modules

- **Don't leak data layout.** `nav.distances(from)` returns a lookup `(tile) => number`, so callers never learn that
  the distances live in a `ty * width + tx` array.
- **Export only what other modules use.** Tuning constants used by one file stay private to it.
- **A self-contained simulation gets its own folder** with its tests and test helpers: `objects/vacuum/`.
- **File order:** header comment, imports, constants, types, small pure helpers, the public API, then private stages
  in the order they are called. Group a long file with `// Section.` comments.

## Comments

- **Every module starts with what it is**: its job, the spec section, whether it is pure, and its state model if it
  has one.
- **Every exported symbol and every constant has a doc comment**, with units.
- **Comments say why**, or what a reader can't see from the line (`// On the y-down map (-fy, fx) is the robot's
  right`). Once a function's name says what a comment said, delete the comment.

## Refactoring

- **A readability refactor changes no behaviour, and proves it.** Run the tests before and after; for a simulation,
  also hash a long seeded run (poses and events every step) before and after, and expect the same hash.
- Keep the refactor in its own commit, apart from behaviour changes.
