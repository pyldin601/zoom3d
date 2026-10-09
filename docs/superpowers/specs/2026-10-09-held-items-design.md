# Held items — design spec

Status: approved design, 2026-10-09. Decision record: [open-decisions.md](../../open-decisions.md) D15.

## 1. Intent

Each person can hold a drink (a beer, a coffee or a wine) in a hand next to their avatar, the way
people hold a drink at a real meetup. It's cosmetic only: there's no drinking animation and no
gameplay effect.

In scope:
- Other people see the item on your avatar disc.
- You see your own drink in first person (§2.1, added 2026-10-09).
- Avatars and drinks bob while walking (§2.2, added 2026-10-09).
- You pick it from the room bar.
- The choice is remembered per browser.

Out of scope:
- Custom or uploaded items.
- Drinking or other gesture animations.
- Any interaction with the map.

## 2. Look

The sketch was agreed in chat on 2026-10-09: avatar style "A", grip "3".

- A cartoon hand with no arm grips the item in front of the disc's lower right.
- Placement is fixed in screen space on the **viewer's right** of the disc. The disc is a
  billboard, so the hand never moves around it.
- Mugs (beer, coffee) are held **by the handle**. The handle and the fist face the disc, and the
  mug body sits on the far side.
- The wine glass is held by the stem, on the same side, with the fist toward the disc.
- With no item, nothing is drawn: there is no empty hand.
- The item casts its own floor shadow, in the same banded style as the disc's (added
  2026-10-09).
  - It sits under the item's centre: the avatar's position moved along the viewer's right by
    `(HELD_LEFT + HELD_TEXEL·w/2) × AVATAR_RADIUS` (w = the item's texel width).
  - Its radius is half the item's world width, `HELD_TEXEL·w·AVATAR_RADIUS / 2`: about 0.18
    tiles for a mug and 0.1 for wine.
  - It is drawn in the same pass as the disc shadows, so discs and items cover it.

The reference art is the beer sprite below. The pixel maps are 13×10, read left to right
starting from the side next to the disc:

```
.......fffff.     f foam      F foam shade
......fffffff     b beer      B beer shade
...oooofFffFf     g glass / handle
...osssobbbbg     s skin      l finger crease    o hand outline
.ossssgbbbbbg
oollllgbbbbBg
oossssgbbbbBg
.ooooogbbbbBg
......gbbbbbg
......ggggggg
```

(The exact strings live in code. The coffee mug and the wine glass follow the same layout:
coffee is a white mug with dark coffee and two steam pixels, wine is a red bowl on a stem.)

Size and position are given in units of the disc's on-screen radius `r`, so the item scales with
distance just like the disc:
- One item texel is 0.08 r, so a 10-texel-tall item is 0.8 r tall.
- The sprite's left edge is at `screenX + 0.15 r`.
- The sprite's top is at `horizon + 0.3 r` (below the horizon).
- So the hand and drink cover the disc's lower right, in front of the body (variant "H", chosen
  2026-10-09 over the first placement, which floated clear of the disc).

These were tuned by eye from sketches.

### 2.1 Your own drink (first person)

Others see the drink on their right of your disc, which is your **left** hand. To match, you see
it in your left hand: at the bottom-left of the screen, with the hand and handle toward the screen
centre and the drink on the outside. It is the in-game sprite mirrored, built once at load
(`apps/web/src/renderer/own-held.ts`).

- One texel is 4.6% of the screen height; the left edge is at 8.3% of the width.
- 45% of the sprite hangs below the bottom edge, so it peeks in (variant "D"). The hand reaches
  the bottom edge, so there is no sleeve to draw.
- It is drawn over the scene after the sprites, only in a room, and not with nothing in hand.
- It stays clear of the camera preview in the bottom-right corner.

### 2.2 Walking bob

A small tracker per walker (`apps/web/src/renderer/bob.ts`) turns distance walked into a step
phase: one step per 0.6 tiles, so the bob follows real speed and needs no protocol change. Remote
walkers use their interpolated positions.

- **Avatars:** the disc rises up to 0.1 r at the top of each step. Its floor shadow stays put.
- **Their drink** rises the same amount, half a step (0.9 rad) behind the disc, so it swings.
- **Your own drink** drops up to 3% of the height and sways up to 1% of the width either way,
  one way per step.
- After stopping, the bob eases out over 150 ms. A jump of a tile or more in one frame (resume,
  correction) is not counted as walking.

## 3. Data

In `packages/shared`:

```ts
export const HELD_ITEMS = ['beer', 'coffee', 'wine'] as const;
export type HeldItem = (typeof HELD_ITEMS)[number];
export function isHeldItem(v: unknown): v is HeldItem;
```

`PeerInfo` gains `held: HeldItem | null`.

## 4. Protocol (extends design spec §7.2)

Client → server: `held {item: HeldItem | null}`.

Server → client: `peer_held {id, item: HeldItem | null}`. `Peer` gains `held`.

Validation:
- **Client → server is strict.** `item` must be `null` or one of `HELD_ITEMS`. Anything else
  fails `parseClientMessage` and is dropped.
- **Server → client is lenient** (forward compatible).
  - A missing `held` in `Peer` means `null`, the same as with an older server.
  - An unknown item string in `Peer.held` or `peer_held.item` is read as `null`, not as an
    invalid message, so a newer server that adds items doesn't break older clients.
- The existing token bucket (60 msg/s) covers `held`. It gets no limit of its own.

There's no `held` field in `join`, which follows the `media` pattern:
- After every `welcome` (fresh or resumed), the client sends its current `held` once it has
  one, **including `null`**. Otherwise a "Nothing" picked while disconnected would never reach a
  resumed slot, which still holds the old item.
- A fresh identity starts at `null` on the server.

## 5. Server (`apps/server`)

- `Peer.held` starts as `null` and is included in `info()`, which feeds `welcome.peers` and
  `peer_joined`.
- `Lobby.held(conn, msg)` sets `peer.held` and broadcasts `peer_held` to the rest of the room,
  just as `media` does.
- `server.ts` routes `msg.type === 'held'` to `lobby.held`.
- Resume keeps the slot and its `held`. The client resends it after `welcome` anyway, which is
  harmless.

## 6. Client

### 6.1 Persistence (`apps/web/src/ui/held-store.ts`)

- `loadHeld(storage)` and `saveHeld(storage, item)` use the `localStorage` key `zoom3d.held`.
- A value that `isHeldItem` doesn't accept loads as `null`.
- Storage errors are swallowed, as in `loadAvatar`/`saveAvatar`.

### 6.2 Session (`apps/web/src/net/session.ts`)

- Remembers the local `held` and sends it after each `welcome` once `setHeld` has been called,
  including `null`.
- `setHeld(item)` sends immediately when connected.
- Handles `peer_held` by updating `peer.info.held`.

### 6.3 Room bar (`apps/web/src/ui/screens.ts`)

- A native `<select aria-label="In hand">` sits after the Mic and Cam toggles, with the options
  "Nothing in hand", "Beer", "Coffee" and "Wine". A native control is accessible and needs no
  custom menu code.
- On `change`: call `onHeld(item)`, then `blur()` the select. Otherwise letter keys would pick an
  option by typeahead (W → Wine) instead of moving the player.
- A letter-key `keydown` on the focused select (left focused when the menu closed without a
  change) is cancelled and blurs it, for the same reason.
- Arrow keys still move through the options while the select has focus: the game ignores keys
  aimed at a `SELECT`. Where a closed select commits each arrow step (Windows/Linux Chrome), it
  blurs after one step.
- `showRoomBar` takes a separate `HeldControl { held, onHeld }`, so held items stay out of `MediaControls`.

### 6.4 Renderer (`apps/web/src/renderer/`)

- A new `held-items.ts` holds one pixel map (string rows plus a palette) per item. At module
  load it converts each one to `{ w, h, texels: Uint32Array }` in packed `rgb()` form, with 0
  meaning transparent.
- `Sprite` gains `held: HeldItem | null`.
- `renderSprites` draws each sprite's item right after its disc, so the existing back-to-front
  order also covers the items.
  - The item is nearest-sampled over its screen rectangle (§2) and clipped to the framebuffer.
  - Each column is depth-tested against `zbuffer` with the disc's depth.
  - Transparent texels are skipped.
- Hot path: no allocations per frame or per column. The textures are prebuilt, and the
  rectangle maths uses locals only.
- `main.ts` passes `peer.info.held` into the sprite.

## 7. Testing (failing test first for logic)

- **shared protocol:**
  - `held` parses with `null` and with each item.
  - Unknown strings, numbers and a missing `item` are rejected.
  - `peer_held` with an unknown item parses to `item: null`.
  - `Peer` without `held` gives `null`; `Peer` with an unknown `held` gives `null`.
- **lobby:**
  - A new peer has `held: null`.
  - `held` updates the peer and broadcasts `peer_held` to the others, not the sender.
  - `welcome.peers` and `peer_joined` carry `held`.
  - Resume keeps it.
  - It's ignored before `join`.
- **held store:** round trip, a junk value gives `null`, and storage that throws is tolerated.
- **session:**
  - Resends `held` after `welcome` and after a resumed `welcome`.
  - Resends `null` too; sends nothing if `setHeld` was never called.
  - Applies `peer_held`.
- **renderer:**
  - Item pixels land to the right of the disc at the expected rows.
  - A farther sprite has a proportionally smaller item.
  - A wall nearer than the sprite hides the item.
  - `held: null` draws nothing extra.
- **room bar:** selecting an option calls `onHeld` with the item (or `null`) and blurs the
  select.
- **Manual check:** two tabs in one room. Pick beer in one tab and watch it appear on that
  avatar in the other. Reload; the choice is kept. Walk behind a wall; the item is hidden along
  with the disc.
