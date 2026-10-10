# Mobile (phones, portrait first) — design spec

Status: draft, 2026-10-10. Decision record: [open-decisions.md](../../open-decisions.md) D12, D14 (both amended
by this spec).

## 1. Intent

People should be able to join a room from a phone, usually held upright, and have a good conversation there.
On a phone, someone mostly **stands and talks** and walks only now and then. So the screen's job is to show
the faces in front of you large and clear, and the controls' job is to stay out of the way until needed.

Today the game is a fixed 16:9 box letterboxed in the window (decision D14), and the only controls are keyboard
and mouse. On an upright phone that leaves a thin strip of game with no way to move.

Must work on **iOS Safari** and **Android Chrome** (user's call). Landscape phones and tablets should work too,
since they fall out of the same rules, but portrait is the case to tune for.

### Goals
- The 3D view fills the phone screen in either orientation, shaped to it (no letterbox, no cropping).
- Faces of people in front of you are large enough to read expressions in portrait.
- You can walk, strafe and turn with touch, using one thumb to move and the other to turn, at the same time.
- Everything that's keyboard-only today has a tap equivalent: drinks (pick, sip, cheers), boombox, map.
- Home (landing) and lobby screens fit and work on a narrow screen.
- Desktop looks and behaves exactly as it does now.

### Non-goals
- Native apps, installable PWA, fullscreen API.
- New room features, or a different control scheme on desktop.
- The audio tuning panel (`` ` ``) on touch. It's a tuning tool. Boombox start/stop gets its own tap control
  (§5.3).
- Switching camera (front/rear) from inside the room.
- New analytics events.

### Anti-goals (a failure even if it works)
- Controls that cover the faces you're talking to.
- Anything that drops the frame rate on desktop, or allocates in the per-frame/per-column hot path.
- Page scroll, pinch-zoom or double-tap zoom kicking in while you play.
- A phone user hearing nothing, or peers hearing nothing, because of an iOS audio or autoplay rule.

## 2. Frame: shaped to the screen

The user first suggested switching from "contain" to "cover". We rejected that: on a 390×844 phone, covering
with a 16:9 picture keeps only about a quarter of its width, so the 66° view shrinks to ~17° and most
avatars sit off-screen. Instead, the frame takes the window's shape.

### 2.0 Touch mode
*My call:* one **touch mode** flag, set once at page load from `matchMedia('(pointer: coarse)')` (the primary
pointer), never changed during the session. All phone behavior keys off it: the full-window frame (§2.1–2.2),
UI scale (§2.5), the reflowed landing and lobby (§3), and the room UI (§5). Screen width doesn't decide any of
this, so a narrowed desktop window looks as it does today. Phones and tablets (iPad included) get touch mode.
A touchscreen laptop (primary pointer fine) stays in desktop mode. Only its touch controls appear, after the
first touch (§4.1).

### 2.1 Viewport
- `fitViewport` (`packages/shared/src/viewport.ts`) is replaced by a function that returns a box filling the
  whole window, plus the internal framebuffer size for that box.
- **Desktop doesn't change.** Outside touch mode, keep today's 16:9 letterbox, the integer-scale option, the
  640×360 buffer and the 66° FOV. Only touch mode gets the full-window frame. *(`e2e/viewport.spec.ts` keeps
  passing unchanged.)*
- Internal size on touch: the long side is 640 px, and the short side follows the window's aspect ratio,
  rounded to an even number (e.g. 296×640 portrait on a 390×844 phone). That's a smaller pixel count than
  desktop's 640×360.
- The framebuffer, its `ImageData`, the `zbuffer` and the canvas's `width`/`height` are rebuilt **only when
  the internal size actually changes** (rotation, a window resize), never per frame.

### 2.2 Field of view
The FOV is no longer a constant (`walls.ts` `FOV`, also imported by `sprites.ts` and used by `labels.ts`
through `projectSprite`). It becomes a value passed in with the frame, and a pure function picks it from the
aspect ratio:

- aspect (w/h) ≥ 16/9: horizontal FOV 66° (today's).
- aspect ≤ 9/19.5 (a tall phone): horizontal FOV **50°**.
- in between: interpolate linearly in aspect.

*My call, to tune on a real phone:* the 50° floor. The test for it: a person standing 2 tiles straight ahead
in portrait has a face disc at least ~⅓ of the screen width, and two people standing side by side 3 tiles
away both fit. The projection keeps square pixels, so a narrow FOV on a tall frame just shows more floor and
ceiling. That's expected.

### 2.3 Things positioned on the frame
- First-person overlays (own drink, sip, cheers, own boombox) are already placed as fractions of the
  framebuffer's width/height. Check each in portrait. Anything sized from the height (`own-held.ts` texel
  size) may come out too big on a tall frame. Size it from the shorter side instead, and keep desktop pixel
  for pixel identical.
- The automap (HUD) already fits the map into the HUD size, so it should work as is. Check it.
- The HUD canvas is backed at `devicePixelRatio` (3 on many phones, so ~1170×2532). Cap its backing ratio at
  2 on touch devices if profiling shows the per-frame clear/draw costs.

### 2.4 Safe areas and the browser chrome
- Add `viewport-fit=cover` to the viewport meta. The 3D frame fills the whole screen, under the notch and home
  bar. UI elements (top bar, pad, tray, self-view) are inset with `env(safe-area-inset-*)`.
- Size from `visualViewport` (falling back to `innerWidth`/`innerHeight`) and also re-lay out on
  `visualViewport` `resize`. Today a `ResizeObserver` on `<html>` (`stage.ts` `watchLayout`) may not fire
  when the iOS toolbar shows or hides.
- *My call:* ignore resizes caused by the on-screen keyboard. While a text field has focus, don't rebuild the
  frame or re-lay out the stage. Re-lay out once on blur. Otherwise every focus on the lobby's name field would
  squash the frame.
- On the stage and UI: `touch-action: none` on the game surface, no text selection or callouts
  (`-webkit-user-select`, `-webkit-touch-callout`), and no double-tap zoom. Form fields in the lobby stay
  normal, and their font size is ≥ 16 px so iOS doesn't auto-zoom on focus.

### 2.5 UI scale
Today UI text is sized in `em` from the 16:9 box height (`stage.ts`: `box.height * 0.032`). In touch mode, base it
on the **shorter side** of the window, so it comes out about the same in portrait and landscape. Tap targets
must be ≥ 44 CSS px. Builder picks the factor. Desktop is unchanged.

## 3. Home and lobby screens

No new content, only reflow in touch mode:

- **Landing:** the title picture is still the live render (`landing-scene.ts`) at the screen's shape. In
  portrait, the camera angle or position may need adjusting so Max, Ada and Bob stay in view. The logo
  (`landing-logo.ts`) goes top-centre, scaled to fit the width. The panel ("Start a party", privacy link) spans
  the bottom, full width minus margins, instead of the bottom-right corner. *Builder tunes the composition. The
  test: all three characters visible and the logo not clipped on a 390×844 screen.*
- **Lobby:** already a single centred column (`.lobby`, 11em). It needs the new font scaling (§2.5), menus
  that don't run off-screen (the picture menu opens to the right of the disc today, `left: 100%`, so open it
  below in touch mode), and the ≥ 44 px tap targets.
- **Status, notice, error, banner** overlays: check they fit at 320 px wide.

## 4. Touch input

### 4.1 When touch controls show
In touch mode (§2.0), the move pad and the drink and "more" buttons show from the start. Outside touch mode
they appear on the first `pointerdown` with `pointerType === 'touch'`, so a touchscreen laptop gets them in its
desktop layout. They never show on a mouse-only desktop.

Clicking/tapping the game currently calls `requestPointerLock()` (`main.ts`). Only do that for
`pointerType === 'mouse'`. iOS has no pointer lock, and on Android it would be wrong.

### 4.2 Move pad (left thumb)
- Bottom-left, inside the safe area. It looks like four retro arrow buttons in a cross (forward, back, strafe
  left, strafe right), as the user sketched.
- It behaves as **one touch area**, not four separate buttons: a finger down anywhere on it, and the finger's
  angle from the pad's centre picks the direction. Sliding the thumb changes direction without lifting.
  *My call:* 8 sectors, so diagonals (forward+strafe) work. A small dead zone sits in the middle. Values are
  the same −1/0/1 the keyboard produces.
- **Fading:** about 35% opacity at rest, full while touched. *(Builder tunes.)*
- Lifting the finger, `pointercancel`, window blur and tab hide all stop movement (same as the keyboard's
  `reset`).

### 4.3 Turning (right thumb)
- Drag horizontally **anywhere on the 3D view** that isn't the pad or a control. Horizontal movement turns the
  view, fed into the same accumulator as mouse-look (`consumeMouseTurn`), with its own per-pixel factor.
  *Builder tunes it. Aim for a half-screen-width swipe ≈ 90°.* No vertical look.
- No turn buttons (my call, which the user hasn't argued with). They'd sit on the right side, over faces.
- Moving and turning work at once with two fingers: track each `pointerId` separately.

### 4.4 Where it lives in code
Extend `apps/web/src/input/keyboard.ts`'s `Input` (or add a sibling touch module that `createInput` combines).
The rest of the game keeps reading `state()` and `consumeMouseTurn()` and doesn't care where they came from.
Keyboard and touch can be active together: combine them by OR-ing the held actions.

## 5. Room UI on a phone

```
┌────────────────────────┐
│            [🎤][📷][🔗] │  top bar, safe-area inset; link → "copy link" button
│                        │
│     3D view, full      │  drag anywhere here to turn
│     screen, faces      │
│                        │
│                        │
│                  [🍺]  │  drink button, only while holding a drink
│  ┌───┐           [⋯]   │  "more" button opens the tray
│ ◀ ▲ ▶ (pad)       (me) │  pad bottom-left (fades); self-view tile bottom-right
│   ▼                    │
└────────────────────────┘
```

### 5.1 Top bar
The mic and cam toggles stay as they are. In touch mode the invite-link text field (18em) is replaced by a
single **copy link** button with a short "Copied" confirmation. Desktop keeps the field.

### 5.2 Self-view
It stays a small round tile in the bottom-right corner (as today), inset by the safe area, with the drink
button and "more" button stacked above it. Builder places them so the pad and these never overlap at 320 px
wide.

### 5.3 "More" tray (*my call*)
The occasional actions sit behind one **⋯** button. It opens a small tray:
- **Drinks:** beer, coffee, wine, nothing (the same as keys `1`–`3`, `0`, through the same `chooseHeld`).
- **Boombox:** start (opens the file picker, as `B` does) / stop while playing.
- **Map:** on/off (as Tab/M).

The tray closes on picking, on tapping outside it, or on ⋯ again.

### 5.4 Drink button (*my call*)
Sipping and cheers happen while talking, so they get their own button, visible only while you hold a drink. It
shows the drink's icon. **Tap = sip, hold 500 ms = cheers**: the same rules and timing as the number key
(`drink-press.ts`), driven by pointer down/up in place of keydown/keyup.

## 6. Camera, audio and iOS specifics

- **Front camera by default:** with no saved device, the camera request adds `facingMode: 'user'` (as
  `ideal`) to `VIDEO_CONSTRAINTS`. With a saved `deviceId` nothing changes.
- **Audio start:** the lobby already `resume()`s the `AudioContext` synchronously inside the Join submit, and
  that must stay first. Check on iOS that remote voices are audible after Join and after the tab comes back
  from the background.
- **iOS silent switch:** with the ringer switch on silent, Web Audio is muted on iOS unless the page declares
  a play-and-record audio session. Where `navigator.audioSession` exists, set its `type` to `'play-and-record'`
  before capture. Test on a device with the switch both ways.
- **Remote audio into Web Audio** on Safari: the muted-but-playing `<video>`/`<audio>` elements with
  `playsinline` are already in place (`remote-media.ts`). Verify on iOS that voices and the boombox reach the
  spatial engine.
- **Face framing** (`requestVideoFrameCallback`, MediaPipe WASM): verify on iOS. The framer already falls back
  to a centred crop if the detector fails.
- **Speakers, not headphones**, is the normal phone case: `echoCancellation` is already on capture. Check two
  phones in the same room for echo.
- **Backgrounding:** iOS stops the camera when Safari is hidden. The existing hidden-tab swap
  (`framer.sendTrack`) must not leave peers with a frozen face. Coming back should restore the camera.
  Verify, don't redesign.

## 7. Testing

- **Unit (test first):** the new viewport/internal-size function (portrait, landscape, desktop unchanged, odd
  sizes); the FOV-from-aspect function; touch pad sector → `MoveInput` (all 8 sectors, dead zone, slide
  between sectors, cancel/blur resets); drag → turn accumulation with two simultaneous pointers; keyboard and
  touch combined.
- **Renderer:** existing wall/sprite tests keep passing with FOV passed in. Add a case at a portrait size.
- **E2E (Playwright, Chrome):** a mobile-emulated project or spec (`hasTouch`, `isMobile`, 390×844) that
  joins a room, checks the canvas fills the window, moves with the pad, turns with a drag, and picks/sips a
  drink from the tray. The existing desktop specs, including `viewport.spec.ts` and `frame-rate.spec.ts`, run
  unchanged.
- **Bench:** run `pnpm bench` at the portrait internal size too.
- **Manual, on real devices:** an iPhone (Safari) and an Android phone (Chrome) in a room with a desktop user:
  join, faces both ways, voices both ways (iOS silent switch on and off), move/turn, drinks, boombox,
  rotate the phone, background and return. Playwright's WebKit isn't iOS Safari, so this check is required.

## 8. Docs to update in the same change
- `docs/open-decisions.md`: amend **D14** (touch devices get a full-window frame with an aspect-dependent FOV;
  desktop keeps 16:9) and resolve the touch part of **D12**, both dated, linking here.
- `docs/vision.md`: the non-goal "Native apps, mobile-first controls" becomes "Native apps". Phones in the
  browser are now a goal, though not mobile-first.
- `AGENTS.md` gotchas: anything learned about iOS (silent switch, `visualViewport`, pointer lock gating).
- [Design spec](2026-10-08-zoom3d-design.md) §5 (fixed 16:9 viewport) and §6 (input): add a note pointing here.

## 9. Left to the builder
Exact sizes, opacities, the turn factor, the UI font factor, icon art (in the existing `icons.ts` style), the
landing composition in portrait, whether to cap the HUD's DPR, and how to split the work into commits.
