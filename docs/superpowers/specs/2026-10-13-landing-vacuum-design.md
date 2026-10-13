# Landing-page vacuum: design spec

Status: approved design, implemented 2026-10-13. Decision records: [open-decisions.md](../../open-decisions.md) D19 (landing page, amended)
and D22 (robot vacuum, amended).

Calls marked **(my call)** were made by the designer, not by the product owner, and can be overridden.

## 1. Intent

The landing page (`/`) is a single still frame from our own renderer: Max sneaking a beer in the alcove, Ada and Bob
talking down the corridor, the "zoom3d" title in the corner (D19). This change brings that picture to life with the
room's robot vacuum (D22). A visitor who lingers on the page sees the vacuum come out, clean the corridor, bump into
the three of them, and then get lost looking for its dock, which is the same joke the rooms tell.

The scene is a little film, not a toy. It plays the same for everyone and ignores the visitor completely.

### Goals

- On page load the picture looks exactly as it does today.
- **10 seconds** after the picture first shows, the vacuum drives out from a parking spot the camera can't see.
- It cleans the landing corridor patch by patch, using the **same vacuum simulation as the rooms** (§3.1), at the
  same pace.
- It bumps into Ada, Bob and Max the way it bumps into people in a room: it pauses, steps aside and drives round them.
- **The grind is the joke** (product owner, 2026-10-13). A trial run of the unchanged sim on `LANDING_MAP` cleaned the
  corridor in about **9.5 minutes**. About 3 minutes of that went to Ada and Bob's patch and another 3 to Max's
  alcove: about 60 bumps, and 25 waypoints given up because the people stand on them. That is accepted as is. Don't
  shorten it by skipping patches, moving people or tuning the sim.
- When the corridor is clean it searches for its dock **forever**, never finding it, just as in a room: search legs
  and slow circles for as long as the page stays open.

### Non-goals

- **No loop.** It never docks, rests or starts another round. Once lost, it stays lost.
- **No sound** **(my call)**. Browsers block audio until the first user gesture, and the landing page has none before
  "Start a party". The landing page creates no `AudioContext`.
- Ada, Bob and Max **never move or react** to being bumped, the same as players in a room.

### Anti-goals (a failure even if it works)

- **The scene reacts to the visitor.** Clicks, mouse movement, keys and touches must not start, pause, speed up,
  redirect or reset it. The 10 seconds count from when the picture first shows, not from the last input. The camera
  never moves.
- **The first impression changes.** Until the vacuum appears, the page must be the same picture as today: same
  framing, same people, same title, and no vacuum in view.
- **The room's vacuum changes behaviour.** Sharing the simulation must not change what the room vacuum does
  (`apps/server` tests stay green unchanged, apart from import paths).

## 2. Behaviour

### 2.1 Timeline

| Time since the picture first shows | What the visitor sees |
|---|---|
| 0–10 s | Today's still picture. The vacuum is parked out of view. |
| 10 s | The vacuum starts its first step and drives into view. |
| ~10 s – ~10 min | Cleaning, patch by patch, with many bumps (see Goals). |
| afterwards, forever | Searching for its dock: search legs, slow circles, short waits. |

"Time" here is **show time** **(my call)**. It advances only while the page renders frames, so a background tab
(where `requestAnimationFrame` stops) pauses the show and it resumes where it left off. The 10-second wait counts
show time too.

### 2.2 Same show for everyone **(my call)**

The vacuum starts from a fixed parking pose and uses a fixed-seed random generator, and the sim is stepped at a fixed
interval (the server's 66 ms tick or similar; builder's choice) with the drawn pose interpolated between steps. Every
visitor therefore sees the same run regardless of frame rate, and tests can pin it.

### 2.3 The people

Ada, Bob and Max are passed to the sim as the "people" it bumps (`stepVacuum`'s `people`), at their fixed
`LANDING_PEOPLE` positions. They keep their current poses: Ada speaking, Max sipping (still values, as today). They
don't animate (no bob or wobble).

**The camera is a person too** **(my call)**. In a room the viewer is someone the vacuum bumps into, so on the landing
page the viewer's position is a fourth entry in `people`. Without it, the vacuum drives through the camera's spot (it
cleans the camera's patch first), looming up from the bottom of the frame and vanishing beneath it. With it, the trial
run kept the vacuum at least 0.56 tiles away. (Faces dropped at `MIN_DEPTH` never show: a knee-high model that close
is below the frame.) To keep the run the same for everyone (§2.2), this is one fixed
point, `LANDING_CAMERA`'s position, for both the landscape and portrait cameras (they are 0.15 tiles apart).

### 2.4 Start a party, and the lobby

Clicking **Start a party** resets the scene. The show stops for good on this page load, and the lobby shows today's
picture without the title and without the vacuum (D19 as amended 2026-10-10). The lobby picture never animates. The
existing in-page `pushState` flow stays; back/forward still loads the page fresh, so a return to `/` starts the show
from zero.

The `invalid` route (which runs the room loop) is unaffected.

### 2.5 Reduced motion **(my call)**

When `matchMedia('(prefers-reduced-motion: reduce)')` matches at load, the landing page stays today's still picture
and the show never starts. Read it once at load, like `TOUCH`.

### 2.6 Portrait phones

The portrait camera (`LANDING_CAMERA_PORTRAIT`) shows the same show. The parking spot must be out of view of **both**
landing cameras (§3.2).

## 3. How it gets made

### 3.1 One vacuum simulation, shared **(my call)**

The vacuum sim (`apps/server/src/objects/vacuum/vacuum.ts`, `nav.ts` and their tests) is pure. It depends only on
`@zoom3d/shared` and the one-line `pick` helper (`apps/server/src/random.ts`). It moves into `packages/shared` so the
server and the browser run the **same copy**. Where it goes inside the package, and whether `pick` moves with it or
is copied, is the builder's call; `bots.ts` also uses `pick`. Save/restore (`VacuumSave`, `saveVacuum`,
`restoreVacuum`) is server-only in use but may move with the rest.

The sim needs one small addition: a way to create a vacuum at a **given pose** with nothing cleaned yet.
`createVacuum` currently picks a random floor tile. Its behaviour for the server must not change.

No change to the sim's behaviour: the landing vacuum is the room vacuum.

### 3.2 The parking spot **(my call)**

The vacuum starts on a floor spot that neither landing camera can see, close enough to drive into view soon after
10 s, and not so close to the camera point (§2.3) that its first move is a bump. The builder chooses it. The space beside and behind the camera at the corridor's west end may already be out
of view. If it isn't, for both cameras and the vacuum's full radius, add a small nook to `LANDING_MAP` that keeps the
existing picture unchanged. A test pins that the parked vacuum is drawn in neither camera (no voxel pixels in the
frame), the same way the existing tests pin the staging.

Note that `createVacuumNav` cuts the map into 3×3 patches. A nook adds floor the vacuum will also clean, which is
fine and partly hidden from view.

### 3.3 Drawing

The landing picture changes from "drawn once" to "drawn every frame while the show runs". This is a small landing
loop, not the room loop: the room loop still never starts on `/` (D19).

- Each frame redraws what `renderLandingScene` draws today (walls with the baked landing lighting, the three people,
  and the title when shown) and adds the vacuum as a `VoxelInstance` with `VACUUM_MODEL`, passed into
  `renderSprites` like the room does, lit by the landing lighting unless `?lights=off`.
- Before the 10 s mark, the frame is pixel-identical to today's still (the vacuum is parked out of view).
- The builder decides whether to render every frame during the first 10 s or keep the still until the vacuum moves.
- No allocations in the per-frame path (AGENTS.md): the sprites, face texels and voxel instance are built once.

### 3.4 Where the code lives

The builder's call, within the repo's conventions. A pure "landing show" module (time in → vacuum pose out, owning
the sim, the seed and the 10 s wait) is easy to unit-test. `main.ts` drives it from `requestAnimationFrame` on the
landing route and stops it on Start a party.

### 3.5 Tests

- **Unit (pure):** the show keeps the vacuum parked until 10 s; it then leaves the parking spot; it bumps at least
  one of Ada, Bob or Max during the clean; it finishes cleaning and enters `searching`; it is deterministic (two runs
  give the same poses); the parked pose is invisible from both cameras.
- **Existing tests stay green:** the landing staging tests, and every server vacuum test after the move (only import
  paths change).
- **E2E (if cheap):** on `/`, the canvas changes between ~1 s and ~12 s (Playwright clock control or a wait), and the
  lobby picture after Start a party has no vacuum and doesn't change.

## 4. Docs to update in the same change

- `docs/open-decisions.md`:
  - **D19:** amend "the frame is drawn once" to the show described here (10 s, clean, lost forever, no input, reset
    on Start a party, still under reduced motion).
  - **D22:** note that the sim now lives in `packages/shared` and also runs in the browser for the landing page.
- `AGENTS.md`: update the paths in the world-objects gotcha (`apps/server/src/objects/vacuum/` moves).

## 5. Left to the builder

- Exact parking pose and whether a map nook is needed (§3.2).
- Sim step interval and interpolation (§2.2), the seed value, and the module layout (§3.4).
- Where the shared sim lives in `packages/shared`, and how `pick` is shared (§3.1).
- Whether the first 10 s re-render every frame (§3.3).
- How the e2e check is done, or whether it is skipped (§3.5).
