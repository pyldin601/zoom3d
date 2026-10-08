# Avatar Picture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A participant can pick a picture on the join screen that others see instead of initials while their camera is off.

**Architecture:** The client turns the picked file into a 128×128 JPEG data URL, keeps it in
`localStorage`, and sends it in `join`. The server validates it and relays it in `Peer.avatar`
(`welcome`, `peer_joined`). The receiving face source draws it into the face canvas and uses it
as the fallback texture instead of the initials disc.

**Tech Stack:** TypeScript, Vitest (happy-dom for UI), Playwright (Chrome, fake media).

**Spec:** [docs/superpowers/specs/2026-10-08-zoom3d-design.md](../specs/2026-10-08-zoom3d-design.md) §7.2, §7.3, §8.1, §10.

## Global Constraints

- `AVATAR_SIZE = 128`, `AVATAR_MAX_CHARS = 12_000`, only `data:image/jpeg;base64,<base64>` accepted.
- Client→server messages stay capped at `MAX_MESSAGE_BYTES = 16384`; server→client messages at `MAX_SERVER_MESSAGE_BYTES = 131072`.
- Invalid avatar in `join` → peer joins with `avatar: null` (no rejection). Resume keeps the original avatar.
- Storage key `zoom3d.avatar`; storage may be missing or throw.
- The avatar is only drawn via `Image` → canvas; never inserted as HTML.
- No per-frame allocations: the avatar texels are computed once, when the image decodes.

## Review Focus

- A stored avatar that is corrupt/oversized (edited localStorage) must be ignored, not sent or crash the join screen.
- A picked file that isn't a decodable image (e.g. a PDF renamed `.jpg`) shows an inline error and keeps the previous avatar.
- A huge photo (e.g. 4000×3000) still yields ≤ 12 000 chars.
- An avatar that fails to decode on the receiver keeps the initials disc.
- A peer whose camera is live still shows the camera, not the picture.

---

### Task 1: Protocol

**Files:** Modify `packages/shared/src/protocol/protocol.ts`, test `protocol.test.ts`.

**Produces:** `AVATAR_SIZE`, `AVATAR_MAX_CHARS`, `MAX_SERVER_MESSAGE_BYTES`, `isValidAvatar(v: unknown): v is string`,
`JoinMessage.avatar?: string`, `PeerInfo.avatar: string | null`.

- [ ] Tests: `isValidAvatar` accepts a short jpeg data URL; rejects png/svg/`javascript:`, non-base64 chars, > 12 000 chars, non-strings.
  `parseClientMessage` keeps a valid `join.avatar`, drops an invalid one (still a valid join without `avatar`).
  `parseServerMessage` parses `peer_joined` with `avatar` string/null, rejects a peer with a numeric avatar, and accepts a 100 KB welcome but rejects one over `MAX_SERVER_MESSAGE_BYTES`.
- [ ] Run, watch fail; implement (`parseJson(raw, limit)`); run `pnpm --filter @zoom3d/shared test` → pass. Fix compile errors in users of `PeerInfo` (tests' fixtures get `avatar: null`).
- [ ] Commit `feat(shared): avatar field in join and peer info`.

### Task 2: Server

**Files:** Modify `apps/server/src/lobby.ts`, `server.ts` (nothing if `maxPayload` stays 16 KB); test `lobby.test.ts`.

- [ ] Tests: join with avatar → others' `peer_joined.peer.avatar` and a later joiner's `welcome.peers[].avatar` equal it; join without → `null`; resume with a different avatar keeps the original.
- [ ] Implement: `Peer` stores `avatar` (`isValidAvatar(msg.avatar) ? msg.avatar : null`), `info()` includes it. Run `pnpm --filter @zoom3d/server test` → pass.
- [ ] Commit `feat(server): relay avatar pictures`.

### Task 3: Avatar module

**Files:** Create `apps/web/src/media/avatar.ts`, `avatar.test.ts`.

**Produces:**
- `AVATAR_KEY = 'zoom3d.avatar'`
- `loadAvatar(storage: Pick<Storage,'getItem'> | null): string | null` (validated)
- `saveAvatar(storage: Pick<Storage,'setItem'|'removeItem'> | null, avatar: string | null): void`
- `makeAvatar(blob: Blob, deps?: { decode?: (b: Blob) => Promise<CanvasImageSource & {width:number;height:number}>; document?: Document }): Promise<string>` — rejects with `Error('unreadable')` if decode fails, `Error('too_big')` if no quality fits.

- [ ] Tests: storage round-trip, invalid stored value → null, throwing storage → null/no throw, remove on `null`.
  `makeAvatar` with a fake decode (3000×2000) and fake canvas: draws the centre square (`drawImage(img, 500, 0, 2000, 2000, 0, 0, 128, 128)`), steps quality down until `toDataURL` output fits, rejects `too_big` when nothing fits, rejects `unreadable` when decode throws.
- [ ] Implement (default decode: `createImageBitmap`). Run → pass.
- [ ] Commit `feat(web): avatar picture encoding and storage`.

### Task 4: Faces, call, session

**Files:** Modify `media/faces.ts`, `media/call.ts`, `net/session.ts`; tests `faces.test.ts`, `call.test.ts`, `session.test.ts`.

- [ ] Tests: `createFace({..., avatar})` with a fake `Image` keeps initials until `onload`, then `texels` is a new buffer drawn from the image (drawImage called with the image, 0,0,FACE_SIZE,FACE_SIZE); `onerror` keeps initials; live video still wins over the avatar. `createCall` passes `peer.avatar` to `createFace`. `createSession({avatar})` sends it in `join` (and on resume); `null` omits it.
- [ ] Implement: `createFace` opts gain `avatar?: string | null` and an injectable `createImage?: () => HTMLImageElement` (default `new Image()`); fallback texels variable switches on load. Run `pnpm --filter @zoom3d/web test` → pass.
- [ ] Commit `feat(web): show avatar pictures when the camera is off`.

### Task 5: Join screen and wiring

**Files:** Modify `ui/screens.ts`, `main.ts`, `index.html` (styles); tests `screens.test.ts`, `e2e/avatar.spec.ts`.

- [ ] Tests (happy-dom): `showJoin` with `defaultAvatar` shows an `img` preview; without, the preview shows initials of the typed name; choosing a file calls `makeAvatar` (injected `pickAvatar(file) => Promise<string>`) and updates the preview; a rejection shows "Couldn't read that picture"; Remove clears it; submit calls `onJoin(name, avatar)`.
- [ ] Implement; `main.ts` loads/saves avatar, passes it to the session; banner text says "picture or initials".
- [ ] E2E: A sets a solid red PNG (generated in the test), joins, turns cam off; B sees A's face texels predominantly red. A reloads: the join screen still shows the picture.
- [ ] Run `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` → all pass.
- [ ] Commit `feat(web): pick an avatar picture on the join screen`.
