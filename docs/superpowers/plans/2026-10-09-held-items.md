# Held Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A participant can pick a drink (beer, coffee or wine) in the room bar, and everyone else sees it held in a pixel-art hand next to that participant's avatar disc.

**Architecture:**
- **Shared:** `packages/shared` gains the item list and a `held` / `peer_held` message pair, and
  `Peer` gains a `held` field.
- **Server:** the lobby stores `held` per peer and relays changes, following the `media` path.
- **Client (data):** the client remembers the choice in `localStorage` and resends it after every
  `welcome`.
- **Client (drawing):** the renderer draws a prebuilt item texture beside each disc, depth-tested
  per column.

**Tech Stack:** TypeScript, Vitest (happy-dom for UI), Biome.

**Spec:** [docs/superpowers/specs/2026-10-09-held-items-design.md](../specs/2026-10-09-held-items-design.md) (and design spec §7.2).

## Global Constraints

- `HELD_ITEMS = ['beer', 'coffee', 'wine'] as const`; "nothing" is `null`, never a string.
- Client → server `held` is strict: an unknown or missing `item` means `parseClientMessage` returns `null`.
- Server → client parsing is lenient: a missing or unknown `held` / `item` reads as `null`, and the message is still accepted.
- `localStorage` key: `zoom3d.held`.
- Geometry in disc radii `r` (on-screen):
  - one texel is `0.08 r`
  - the sprite's left edge is at `screenX + 1.05 r`
  - the sprite's top is at `horizon − 0.3 r`
- No allocations in `renderSprites`' per-frame or per-column path.
- Code style: Biome (`pnpm exec biome check --write .`), braces on every `if`/`for` body, single quotes, 120 columns.
- Commit messages: imperative mood, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **"Nothing" picked while disconnected, then resumed.** The server still has `beer` for the resumed
   slot. The client must resend `held: null` after `welcome`, so `null` counts as a value once
   `setHeld` has been called. This deviates from spec §4 ("if it isn't `null`"); Task 4 fixes the
   spec. Test is in Task 4.
2. **Typeahead in the focused select.** After picking, pressing `B` or `C` would silently switch to
   Beer or Coffee. The select must blur on `change`. Test is in Task 5.
3. **A very near sprite whose item crosses the right screen edge.** Column clipping must stop at
   `width − 1`, otherwise writes wrap into the next row's left edge. Test is in Task 3.
4. **Mixed versions.** A peer from an older server has no `held` field, and a newer server may send
   an item this client doesn't know. Both must parse as `null` and not drop the `welcome`. Test is
   in Task 1.
5. **Late joiner.** Someone who joins after A picked beer must see A's beer from `welcome.peers`
   without waiting for a `peer_held`. Test is in Task 2.

---

### Task 1: Shared protocol — items, `held`, `peer_held`, `Peer.held`

**Files:**
- Modify: `packages/shared/src/protocol/protocol.ts`
- Test: `packages/shared/src/protocol/protocol.test.ts`
- Modify (add `held: null` to `PeerInfo` fixtures so typecheck passes): `apps/web/src/net/session.test.ts` (`peer()`), `apps/web/src/media/call.test.ts` (peer fixture)

**Interfaces:**
- Produces:
  - `HELD_ITEMS`
  - `type HeldItem = (typeof HELD_ITEMS)[number]`
  - `isHeldItem(v: unknown): v is HeldItem`
  - `PeerInfo.held: HeldItem | null`
  - `type HeldMessage = { type: 'held'; item: HeldItem | null }`, added to `ClientMessage`
  - `{ type: 'peer_held'; id: string; item: HeldItem | null }`, added to `ServerMessage`

- [ ] **Step 1: Write the failing tests** in `protocol.test.ts`.
  - Add `held: null` to the `peer` fixture in `describe('parseServerMessage')`.
  - Add `{ type: 'peer_held', id: 'p1', item: 'beer' }`, `{ type: 'peer_held', id: 'p1', item: null }` and `{ type: 'peer_joined', peer: { ...peer, held: 'wine' } }` to `samples` (round-trip).
  - Add a new block:

```ts
describe('held items', () => {
  test('isHeldItem accepts only the listed items', () => {
    expect(HELD_ITEMS).toEqual(['beer', 'coffee', 'wine']);
    for (const item of HELD_ITEMS) {
      expect(isHeldItem(item)).toBe(true);
    }
    for (const v of ['pizza', '', null, undefined, 1, 'Beer']) {
      expect(isHeldItem(v)).toBe(false);
    }
  });

  test('client held accepts null or an item and strips extra fields', () => {
    expect(parseClientMessage(json({ type: 'held', item: 'coffee', x: 1 }))).toEqual({ type: 'held', item: 'coffee' });
    expect(parseClientMessage(json({ type: 'held', item: null }))).toEqual({ type: 'held', item: null });
  });

  test('client held rejects unknown, non-string and missing items', () => {
    expect(parseClientMessage(json({ type: 'held', item: 'pizza' }))).toBeNull();
    expect(parseClientMessage(json({ type: 'held', item: 3 }))).toBeNull();
    expect(parseClientMessage(json({ type: 'held' }))).toBeNull();
  });

  test('peer_held with an unknown item (newer server) parses as null', () => {
    expect(parseServerMessage(json({ type: 'peer_held', id: 'p1', item: 'pizza' }))).toEqual({
      type: 'peer_held',
      id: 'p1',
      item: null,
    });
    expect(parseServerMessage(json({ type: 'peer_held', item: 'beer' }))).toBeNull();
  });

  test('a peer without held (older server) or with an unknown held parses with held null', () => {
    const { held: _, ...old } = peer; // reuse the parseServerMessage fixture: hoist it to module scope
    expect(parseServerMessage(json({ type: 'peer_joined', peer: old }))).toEqual({
      type: 'peer_joined',
      peer: { ...peer, held: null },
    });
    expect(parseServerMessage(json({ type: 'peer_joined', peer: { ...peer, held: 'pizza' } }))).toEqual({
      type: 'peer_joined',
      peer: { ...peer, held: null },
    });
  });
});
```

  (Hoist the `peer` fixture out of `describe('parseServerMessage')` to module scope so both blocks share it.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @zoom3d/shared exec vitest run src/protocol/protocol.test.ts`
Expected: FAIL (`HELD_ITEMS` / `isHeldItem` not exported).

- [ ] **Step 3: Implement in `protocol.ts`**
  - Constants and `isHeldItem` go next to the avatar helpers.
  - `parseClientMessage` `'held'` branch: `m.item === null || isHeldItem(m.item)`, otherwise `null`. A missing `item` is `undefined`, so it is rejected.
  - `peerInfo()`: `held: isHeldItem(v.held) ? v.held : null`.
  - `parseServerMessage` `'peer_held'` case: requires `isStr(m.id)`; `item: isHeldItem(m.item) ? m.item : null`.
  - Add `held: null` to the two web `PeerInfo` fixtures listed under Files.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @zoom3d/shared exec vitest run && pnpm typecheck`
Expected: shared tests PASS. Typecheck may fail only in `apps/server/src/lobby.ts` (`info()` lacks `held`), which is fixed in Task 2. Any other error must be fixed now.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/web/src/net/session.test.ts apps/web/src/media/call.test.ts
git commit -m "Add held items to the shared protocol"
```

---

### Task 2: Server — store and relay `held`

**Files:**
- Modify: `apps/server/src/lobby.ts`, `apps/server/src/server.ts`
- Test: `apps/server/src/lobby.test.ts`, `apps/server/src/server.test.ts`

**Interfaces:**
- Consumes: `HeldMessage`, `PeerInfo.held` (Task 1).
- Produces: `Lobby.held(conn: string, msg: HeldMessage): void`.

- [ ] **Step 1: Write the failing tests** in `lobby.test.ts`, inside a new `describe('held items')`:

```ts
test('a new peer holds nothing', () => {
  join('A');
  join('B');
  expect(welcome('B').peers[0]?.held).toBeNull();
});

test('held is broadcast to the others, not the sender, and shown to later joiners', () => {
  join('A');
  join('B');
  const aSent = to('A').length;
  lobby.held('A', { type: 'held', item: 'beer' });
  expect(last('B')).toEqual({ type: 'peer_held', id: welcome('A').selfId, item: 'beer' });
  expect(to('A')).toHaveLength(aSent);
  join('C');
  expect(welcome('C').peers.find((p) => p.name === 'A')?.held).toBe('beer');
  expect(to('A').at(-1)).toMatchObject({ type: 'peer_joined', peer: { held: null } });
});

test('resume keeps held', () => {
  join('A');
  join('B');
  lobby.held('B', { type: 'held', item: 'wine' });
  lobby.disconnect('B');
  join('B2', 'B', { resumeToken: welcome('B').resumeToken });
  join('C');
  expect(welcome('C').peers.find((p) => p.name === 'B')?.held).toBe('wine');
});

test('held before join is ignored', () => {
  lobby.held('ghost', { type: 'held', item: 'beer' });
  expect(sent).toEqual([]);
});
```

  In `server.test.ts`, add `'held is relayed over real sockets'`. Model it on `'two clients see each other and state is relayed'`: A sends `{type:'held', item:'coffee'}`, and B receives `{type:'peer_held', id: <A's id>, item:'coffee'}`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @zoom3d/server exec vitest run`
Expected: FAIL (`lobby.held is not a function`).

- [ ] **Step 3: Implement**
  - `Peer` gets `held: null` at creation.
  - `info()` copies `held`.
  - `held()` mirrors `media()`: look up the peer, set `peer.held`, then broadcast `peer_held`.
  - `server.ts` routes `msg?.type === 'held'` to `lobby.held(conn, msg)`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @zoom3d/server exec vitest run && pnpm typecheck`
Expected: PASS, and typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "Store and relay held items in the lobby"
```

---

### Task 3: Renderer — item textures and drawing

**Files:**
- Create: `apps/web/src/renderer/held-items.ts`
- Modify: `apps/web/src/renderer/sprites.ts`, `apps/web/src/main.ts` (sprite push only: `held: peer.info.held`)
- Test: `apps/web/src/renderer/held-items.test.ts`, `apps/web/src/renderer/sprites.test.ts`

**Interfaces:**
- Consumes: `HeldItem`, `HELD_ITEMS` (Task 1).
- Produces:
  - `interface HeldSprite { w: number; h: number; texels: Uint32Array }` (0 means transparent)
  - `HELD_SPRITES: Record<HeldItem, HeldSprite>`
  - `HELD_TEXEL = 0.08`, `HELD_LEFT = 1.05`, `HELD_TOP = 0.3` (all in disc radii)
  - `Sprite.held: HeldItem | null`

**Art.** One shared palette:
- hand: `s` `#f2c29b`, `l` `#c98d6a`, `o` `#8a5236`
- glass: `g` `#cfe3ea`
- beer: `f` `#f4f1e6`, `F` `#d6cfba`, `b` `#e8a317`, `B` `#b8740f`
- coffee: `t` `#b9c0c8`, `c` `#5a3620`, `w` `#f3f3f3`, `W` `#bdbdbd`
- wine: `R` `#8e1b2b`, `r` `#c23a4c`

`.` is transparent. Column 0 is the side next to the disc.

```ts
beer: [
  '.......fffff.',
  '......fffffff',
  '...oooofFffFf',
  '...osssobbbbg',
  '.ossssgbbbbbg',
  'oollllgbbbbBg',
  'oossssgbbbbBg',
  '.ooooogbbbbBg',
  '......gbbbbbg',
  '......ggggggg',
],
coffee: [
  '.......t..t..',
  '...oooo.t..t.',
  '...osssoccccw',
  '.osssswwwwwww',
  'oollllwwwwwww',
  'oosssswwwwwww',
  '.ooooowwwwwww',
  '......Wwwwwww',
  '.......WWWWW.',
],
wine: [
  'g.....g',
  'g.....g',
  'gRRRRRg',
  'gRRRrRg',
  '.oooRg.',
  '.ossg..',
  '.sssso.',
  '.llllo.',
  '.ooooo.',
  '.ggggg.',
],
```

- [ ] **Step 1: Write the failing tests**

  `held-items.test.ts`:
  - **`every item has a texture of its pixel map size`:** `HELD_SPRITES.beer` is `{w: 13, h: 10}`, coffee is 13×9, wine is 7×10, and `texels.length === w * h`.
  - **`transparent pixels are 0 and opaque ones carry full alpha`:** beer texel `(0,0)` is `0`, and beer texel `(12,9)` equals `hexToRgb('#cfe3ea')`.

  `sprites.test.ts`:
  - Add `held: null` to every existing `Sprite` literal.
  - Add `describe('held items')` with this helper:

```ts
// Screen pixel of item texel (u, v) for a sprite straight ahead at `depth`.
const itemPx = (u: number, v: number, depth: number) => {
  const r = (AVATAR_RADIUS * PROJ) / depth;
  const t = HELD_TEXEL * r;
  return [Math.floor(320 + HELD_LEFT * r + (u + 0.5) * t), Math.floor(180 - HELD_TOP * r + (v + 0.5) * t)] as const;
};
const tex = (u: number, v: number) => HELD_SPRITES.beer.texels[v * HELD_SPRITES.beer.w + u];
```

  Tests:
  - **`a held beer is drawn to the viewer's right of the disc`:** sprite `{x: 3.5, y: 4.5, held: 'beer'}` (depth 2). For `(u,v)` in `[(12,9), (8,5), (2,5)]` (glass, beer, hand), `px(fb, ...itemPx(u,v,2))` equals `tex(u,v)`.
  - **`the item scales with distance`:** sprite at `x: 5.5` (depth 4). The same three texels match `itemPx(u,v,4)`.
  - **`held null draws nothing beyond the disc`:** frame with `held: null` vs `held: 'beer'`. At `itemPx(8,5,2)`, the null frame shows the background (equal to a frame with no sprite).
  - **`walls in front hide the item too`:** use the `walled` map from `'walls in front hide the sprite'` (hoist it). Sprite `{x: 5.5, held: 'beer'}`. `fb.pixels` equals the snapshot taken before `renderSprites`.
  - **`a very near item crossing the right edge does not wrap into the next row`:** sprite `{x: 2.0, y: 4.28}` (depth 0.5, disc centre near column 99). Its item runs past column 639. Render it once with `held: null` and once with `held: 'beer'`. Every pixel in column 0 is identical between the two frames (the disc covers column 0 in both, so compare frames, not a pre-render snapshot).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @zoom3d/web exec vitest run src/renderer`
Expected: FAIL (module `./held-items` not found).

- [ ] **Step 3: Implement**
  - In `held-items.ts`, convert the maps once at module load, using `hexToRgb` from `./sprites` for palette colours. Export the three geometry constants from here too.
  - In `renderSprites`, right after each disc's column loop, draw `sprites[i].held`'s texture if set:
    - `r = size / 2`, `t = HELD_TEXEL * r`, `left = screenX + HELD_LEFT * r`, `top = half − HELD_TOP * r`.
    - Columns run from `max(0, floor(left))` to `min(w − 1, ceil(left + tex.w * t) − 1)`. Skip a column if `depth >= zbuffer[col]`.
    - `u = floor((col + 0.5 − left) / t)`. Rows are clipped the same way to `[0, h − 1]`.
    - `v = floor((row + 0.5 − top) / t)`. Skip `u`/`v` outside the texture and texels equal to `0`.
  - Locals only, no allocations.
  - `main.ts`: add `held: peer.info.held` to `sprites.push`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @zoom3d/web exec vitest run src/renderer && pnpm typecheck && pnpm bench`
Expected: tests PASS and typecheck is clean. The frame time in `pnpm bench` stays within noise of `main` (no allocations were added).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/renderer apps/web/src/main.ts
git commit -m "Draw held items beside avatar discs"
```

---

### Task 4: Client state — held store and session sync

**Files:**
- Create: `apps/web/src/ui/held-store.ts`
- Modify: `apps/web/src/net/session.ts`, `docs/superpowers/specs/2026-10-09-held-items-design.md` (§4 and §6.2: resend after every `welcome` once set, **including `null`**; see Review Focus 1)
- Test: `apps/web/src/ui/held-store.test.ts`, `apps/web/src/net/session.test.ts`

**Interfaces:**
- Consumes: `HeldItem`, `isHeldItem`, `peer_held` (Task 1).
- Produces:
  - `HELD_KEY = 'zoom3d.held'`
  - `loadHeld(storage: Pick<Storage, 'getItem'> | null): HeldItem | null`
  - `saveHeld(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, item: HeldItem | null): void` (`null` removes the key)
  - `Session.setHeld(item: HeldItem | null): void`

- [ ] **Step 1: Write the failing tests**

  `held-store.test.ts`:
  - **`round-trips an item and null`:** uses a `Map`-backed fake storage. `saveHeld(s, 'wine')` then `loadHeld(s)` gives `'wine'`. `saveHeld(s, null)` removes the key, and `loadHeld` gives `null`.
  - **`junk loads as null`:** `getItem` returns `'pizza'`, which loads as `null`.
  - **`throwing or missing storage is tolerated`:** throwing `getItem`/`setItem` and `null` storage do not throw. Loading gives `null`.

  `session.test.ts`, modelled on `'media state is sent once open and re-sent after every welcome'`:
  - **`held is sent once open and re-sent after every welcome, including null`:**
    - `setHeld('beer')` before `welcome` sends nothing.
    - After `welcome`, `[{type:'held', item:'beer'}]` has been sent.
    - `setHeld(null)` sends `{type:'held', item:null}`.
    - After reconnect and `welcome`, the new socket's held messages are `[{type:'held', item:null}]`.
  - **`nothing is sent if setHeld was never called`:** after `welcome`, no `held` messages have been sent.
  - **`peer_held updates the peer and ignores unknown ids`:** `joinedSession([peer('a')])`, then `ws.receive({type:'peer_held', id:'a', item:'coffee'})` gives `session.peers.get('a')?.info.held === 'coffee'`. A `peer_held` for `'zzz'` doesn't throw.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @zoom3d/web exec vitest run src/ui/held-store.test.ts src/net/session.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `held-store.ts` follows `media/avatar.ts` (`loadAvatar`/`saveAvatar`), validating with `isHeldItem`.
  - In `session.ts`, add `let held: HeldItem | null | undefined;`, where `undefined` means `setHeld` was never called.
  - After `welcome`, send it when `held !== undefined`. This sits beside the `media` resend.
  - `setHeld` mirrors `setMedia`.
  - The `peer_held` case mirrors `peer_media` (no listener callback needed).
  - Update the spec lines named under Files.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @zoom3d/web exec vitest run && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/held-store.ts apps/web/src/ui/held-store.test.ts apps/web/src/net docs/superpowers/specs/2026-10-09-held-items-design.md
git commit -m "Remember the held item and sync it through the session"
```

---

### Task 5: Room bar picker and wiring

**Files:**
- Modify: `apps/web/src/ui/screens.ts`, `apps/web/src/main.ts`
- Test: `apps/web/src/ui/screens.test.ts`

**Interfaces:**
- Consumes: `loadHeld`/`saveHeld` and `Session.setHeld` (Task 4), `HeldItem`/`isHeldItem` (Task 1).
- Produces:
  - `interface HeldControl { held: HeldItem | null; onHeld(item: HeldItem | null): void }`
  - `showRoomBar(root: HTMLElement, inviteUrl: string, controls?: MediaControls, held?: HeldControl): void`

- [ ] **Step 1: Write the failing tests** in `screens.test.ts`.
  - **`room bar held picker shows the current item and reports changes`:**
    - Call `showRoomBar(root, 'http://x', undefined, { held: 'coffee', onHeld })`.
    - The `select[data-control="held"]` has `aria-label` `"In hand"`, value `'coffee'`, and option texts `['Nothing in hand', 'Beer', 'Coffee', 'Wine']`.
    - Setting value `'wine'` and dispatching `change` calls `onHeld('wine')`.
    - Setting value `''` and dispatching `change` calls `onHeld(null)`.
  - **`the held picker gives up focus after a change`:** focus the select, change it, and `document.activeElement` is no longer the select.
  - **`no held control renders no picker`:** `showRoomBar(root, 'http://x')`, and `select[data-control="held"]` is `null`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @zoom3d/web exec vitest run src/ui/screens.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `screens.ts`:
    - Option values are `''`, `'beer'`, `'coffee'` and `'wine'`.
    - The picker sits after the Mic/Cam toggles and before the invite link.
    - On `change`: `onHeld(isHeldItem(select.value) ? select.value : null)`, then `select.blur()`.
  - `main.ts` `joinRoom`:
    - `const held = loadHeld(storage())`.
    - Call `session.setHeld(held)` right after `createSession`.
    - Pass `{ held, onHeld(item) { saveHeld(storage(), item); session?.setHeld(item); } }` as the fourth `showRoomBar` argument.

- [ ] **Step 4: Verify everything**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

Manual (spec §7):
1. `pnpm dev`, then open two tabs on one room.
2. Pick Beer in tab 1. In tab 2, a hand holding a beer by the handle appears on the viewer's right of tab 1's disc.
3. Reload tab 1: the picker still shows Beer, and tab 2 still sees it.
4. Walk tab 2 behind a wall: the item disappears together with the disc.
5. Pick Nothing: the hand disappears.

Tune `HELD_TEXEL` / `HELD_LEFT` / `HELD_TOP` by eye only if needed, and update spec §2 to match.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/screens.ts apps/web/src/ui/screens.test.ts apps/web/src/main.ts
git commit -m "Add the held item picker to the room bar"
```
