# Server fan-out (6d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-move `peer_state` relays with one batched, distance-tiered `peers` message per client per server
tick, move avatar pictures to `GET /avatar/<id>`, and open rooms to 128 people.

**Architecture:** The lobby stores poses and bumps a per-peer `poseVersion`. A pure `fanout.ts` picks, per recipient,
which changed poses go out this tick (near every tick, far every 500 ms). The server drives one 15 Hz timer: step bots
and vacuums, then fan out. Avatars live in a content-addressed, ref-counted store served over HTTP. The client applies
batches by slot and gives each peer a render delay by distance tier, slewed so tier changes never jump.

**Tech Stack:** TypeScript, Node `ws` + `node:http`, `@prometheus-io/client`, Vitest, Playwright, Biome.

**Spec:** [docs/superpowers/specs/2026-10-11-server-fan-out-design.md](../specs/2026-10-11-server-fan-out-design.md)

## Global Constraints

- Constants in `packages/shared/src/protocol/protocol.ts`: `FANOUT_TICK_MS = 66`, `NEAR_TILES = 16`,
  `FAR_INTERVAL_MS = 500`, `MAX_PEERS = 128`, `PROTOCOL_VERSION = 2`.
- Rounding on the wire: `x`, `y` to 0.01 tile, `angle` to 0.001 rad.
- `LABEL_TILES = 10` (labels and automap names).
- `LobbySnapshot.version` stays `1`; snapshot peers keep the avatar as a JPEG data URL.
- Avatar id: first 22 chars of base64url SHA-256 of the data URL. Response: `image/jpeg`,
  `Cache-Control: public, max-age=31536000, immutable`; 404 for unknown.
- Error code `outdated`, text `zoom3d was updated: reload the page`. A join without `v` gets `invalid_room`.
- Metric `zoom3d_peers_batch_entries` (histogram of entries per `peers` message).
- Code style: AGENTS.md (braced blocks, Biome). No allocations in the client's per-frame path.

## Review Focus

1. **A peer that stood still, then moves:** its first update must not snap; the client inserts a hold snapshot (Task 5).
2. **A far peer crossing into near range (and back):** the render delay slews (≤ 0.5 ms per ms), never jumps (Task 5).
3. **A resume or welcome mid-room:** tracking is reset so nobody is skipped or doubly stale after reconnect (Task 2).
4. **A peer leaving while batches are in flight:** a late entry for its slot is ignored; slots never reused (Tasks 2, 5).
5. **Two people sharing one picture, one leaves:** the other's `/avatar/<id>` keeps working (Task 3).

---

### Task 1: Protocol

**Files:** Modify `packages/shared/src/protocol/protocol.ts`, `packages/shared/src/protocol/protocol.test.ts`.

**Interfaces — Produces:**
- `PeerInfo.slot: number`; `PeerInfo.avatar: string | null` now an avatar id (`isAvatarId`).
- `type PeerEntry = [slot: number, x: number, y: number, angle: number]`;
  `ServerMessage` gains `{ type: 'peers'; s: PeerEntry[] }`, loses `peer_state`.
- `JoinMessage.v?: number`; `ErrorCode` gains `'outdated'`.
- `isAvatarId(v: unknown): v is string` (`/^[A-Za-z0-9_-]{22}$/`), `avatarPath(id: string): string` → `/avatar/<id>`.
- `peerEntry(slot, x, y, angle): PeerEntry` (rounds).

- [ ] Tests: `peers` parses, drops malformed entries (non-integer slot, non-finite numbers, wrong length) and keeps the
  rest; `peer_state` no longer parses; `parsePeerInfo` requires an integer `slot ≥ 0` and reads a non-id avatar as
  `null`; `join` keeps an integer `v ≥ 1`, drops anything else; `error` with `outdated` parses; `peerEntry(3, 1.23456,
  2.5, 0.12345)` → `[3, 1.23, 2.5, 0.123]`.
- [ ] Run `pnpm vitest run packages/shared` → fail. Implement. Run → pass. Commit.

### Task 2: Lobby fan-out, slots, colours, version gate

**Files:** Create `apps/server/src/fanout.ts`, `fanout.test.ts`, `colors.ts`, `colors.test.ts`. Modify `lobby.ts`,
`lobby.test.ts`, `bots.test.ts`, `vacuum-lobby.test.ts`.

**Interfaces — Produces:**
- `fanout.ts`: `interface Subject { id; slot; x; y; angle; poseVersion }`,
  `type SentLog = Map<string, { version: number; at: number }>`,
  `selectBatch(self: {id,x,y}, subjects: Iterable<Subject>, sent: SentLog, now: number): PeerEntry[]` — includes a
  subject whose `poseVersion` differs from `sent` when near (`≤ NEAR_TILES`) or `now - at ≥ FAR_INTERVAL_MS`, and
  records it.
- `colors.ts`: `pickColor(used: ReadonlySet<string>): string` — `PEER_COLORS` in order, then golden-angle hues
  (137.508°) at fixed saturation/lightness as `#rrggbb`, skipping used.
- `Lobby.fanOut(): void` sends one `peers` per connected person with a non-empty batch. `state()` sends nothing, bumps
  `poseVersion` only when the pose changed. Welcome resets the recipient's log to everyone's current version at `now`;
  `peer_joined` records the newcomer in every recipient's log. Per-room slot counter, never reused; restore assigns
  fresh slots. Bots: `bot?: true`, step bumps `poseVersion`, no `peer_state`. Join without `v` → `invalid_room`
  (`rejected` reason `outdated`); `v < PROTOCOL_VERSION` → `outdated`.

- [ ] Tests (fanout): near subject each call when changed; unchanged never resent; far subject at most every 500 ms;
  self excluded; entries rounded.
- [ ] Tests (colors): first 8 = `PEER_COLORS`; 120 picks with each added to `used` are distinct valid hex and none grey
  (max−min channel ≥ 64); a used colour is skipped.
- [ ] Tests (lobby): a move is not sent on `state()`, but on the next `fanOut()` batched with others; slots unique and
  survive resume; a resumer's welcome resets tracking (no stale resend); bots go out in batches; joins without `v` /
  with old `v` rejected with the right codes; the 9th..128th person gets a generated colour; `MAX_PEERS` cap.
- [ ] Update existing tests that expected `peer_state`. Run `pnpm vitest run apps/server` → pass. Commit.

### Task 3: Avatars over HTTP

**Files:** Create `apps/server/src/avatars.ts`, `avatars.test.ts`. Modify `lobby.ts`, `snapshot.ts`,
`snapshot.test.ts`, `server.ts`, `server.test.ts`, `apps/web/nginx/default.conf.template`, `apps/web/vite.config.ts`.

**Interfaces — Produces:**
- `avatarId(dataUrl: string): string`; `class AvatarStore { add(dataUrl): string; release(id): void;
  get(id): Buffer | null }` (ref-counted; `get` returns decoded JPEG bytes).
- `Lobby.avatar(id: string): Buffer | null`. Internal `Peer.picture: string | null` (data URL); wire `avatar` = id.
- `SnapshotPeer = Omit<PeerInfo, 'slot'> & { resumeToken; lastAcceptedAt }` with `avatar` = data URL.

- [ ] Tests: id = hash prefix; two adds of one picture share an entry until both released; welcome/peer_joined carry
  ids; snapshot round-trip keeps the data URL and restore rebuilds the store; `GET /avatar/<id>` → 200 with headers and
  the JPEG bytes, unknown → 404; a join without `v` over a real socket gets `invalid_room`; `peers` replaces
  `peer_state` in the socket tests and metrics (`messages_sent_total{type="peers"}`, histogram present).
- [ ] Server: one timer at `FANOUT_TICK_MS` → `stepWorld(FANOUT_TICK_MS)` then `fanOut()`; histogram observed in the
  outbox for `peers`. nginx `location ^~ /avatar/` proxies to `$zoom3d_server`; vite proxies `/avatar` to the server
  (http form of `ZOOM3D_SERVER_URL`).
- [ ] Run `pnpm vitest run apps/server` → pass. Commit.

### Task 4: Client session and avatars

**Files:** Modify `apps/web/src/net/session.ts`, `session.test.ts`, `connection.ts`, `connection.test.ts`,
`apps/web/src/media/call.ts`, `apps/web/src/main.ts`.

**Interfaces — Produces:** `RemotePeer` loses `lastSeq`, gains `delay: PeerDelay` (Task 5). Session keeps a
slot → peer map; `peers` entries update `info` pose and push into the buffer (with the hold of Task 5); unknown slots
ignored. Join sends `v: PROTOCOL_VERSION`. `outdated` is fatal; `statusText` shows its text and
`This room is full (${MAX_PEERS} people)`. `call.ts` passes `avatarPath(id)` to `createFace`.

- [ ] Tests: a batch moves the right peers by slot; unknown and departed slots make no ghosts; welcome rebuilds the
  slot map; join carries `v: 2`; `outdated` stops reconnecting.
- [ ] Run `pnpm vitest run apps/web/src/net` → pass. Commit together with Task 5.

### Task 5: Per-peer render delay and pause hold

**Files:** Create `apps/web/src/net/peer-delay.ts`, `peer-delay.test.ts`. Modify `session.ts`, `main.ts`.

**Interfaces — Produces:**
- `nearTier(px, py, x, y): boolean` — distance `≤ NEAR_TILES - 1` (a tile inside the server's line: when unsure, be
  smooth-but-late rather than choppy).
- `class PeerDelay { value: number; update(t: number, near: boolean): number }` — target `INTERP_DELAY_MS` (near) or
  `FAR_DELAY_MS = 750` (far); first call jumps to target, later calls move at most `0.5 × (t − lastT)` toward it.
- `holdBefore(buffer: SnapshotBuffer, t: number, intervalMs: number): void` — if the latest snapshot is older than
  `t − intervalMs`, pushes a copy of it at `t − intervalMs` (no allocation beyond the buffer's own copy).
- `main.ts` `refreshPositions` samples each peer at `now − peer.delay.update(now, nearTier(...))`.

- [ ] Tests: first update = target; slew limit both ways; hold inserted after a pause, not during steady updates;
  `nearTier` boundary.
- [ ] Run `pnpm vitest run apps/web` → pass. Commit.

### Task 6: Labels and automap names nearby only

**Files:** Modify `apps/web/src/renderer/labels.ts`, `automap.ts`, `automap.test.ts`.

**Interfaces — Produces:** `LABEL_TILES = 10`, `inLabelRange(p: {x,y}, x, y): boolean` in `labels.ts`.

- [ ] Tests: automap draws a dot for everyone but a name only within 10 tiles; `inLabelRange` boundary.
- [ ] Run → pass. Commit.

### Task 7: Docs, checks and e2e

- [ ] Spec status → built, §2.3 updated to the distance-tier delay; D21 6d marked built; roadmap row; AGENTS.md
  gotchas (batched state, avatars route, protocol version); memory updated.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` → pass. `pnpm e2e` → existing specs pass. Commit, push, open PR.
