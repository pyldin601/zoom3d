# Dynamic subscription (6c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each client receives only the faces it can see (sized to how big they are on screen) and the voices it can hear; senders pause face sizes nobody receives.

**Architecture:**
- The renderer reports per-peer facts (drawn columns, projected size).
- A pure rule (`media/interest.ts`) turns facts, positions and audio range into per-peer wants with look-ahead, holds and caps.
- The LiveKit transport subscribes per publication.
- Senders publish the face as three separate tracks (256/128/64) and turn dynacast on.

**Tech Stack:** TypeScript, `livekit-client` 2.22, Vitest, Playwright, local `livekit-server`.

**Spec:** [docs/superpowers/specs/2026-10-11-dynamic-subscription-design.md](../specs/2026-10-11-dynamic-subscription-design.md)

## Global Constraints

- **Track names:**
  - `face` (256², 24 fps, 350 kbps, `source: camera`)
  - `face-128` (128², 24 fps, 120 kbps)
  - `face-64` (64², 15 fps, 35 kbps)

  All with `simulcast: false`; the two small ones use `source: unknown`.
- **Room options:** `dynacast: true`, `autoSubscribe: false`, `adaptiveStream: false`, `stopLocalTrackOnUnpublish: false`.
- **Rule constants:**
  - `INTEREST_MS = 250`, `HOLD_MS = 1000`
  - `LOOKAHEAD_TILES = 20`, `LOOKAHEAD_DEG = 15`
  - size thresholds 128 / 48 framebuffer px with 20% hysteresis
  - audio on within `max + 2`, off beyond `max + 4`
  - `MAX_VIDEOS = 12`, `MAX_VOICES = 24`
- **Hidden tab:** video off for everyone at once; audio unchanged.
- **No allocations** in the per-frame renderer path (facts go into reused objects).
- AGENTS.md style; a failing test first for every rule.

## Review Focus

- A peer exactly at a size threshold, or flickering in and out of a doorway, must not flap subscriptions (hysteresis + hold).
- A size switch never blanks the face (make-before-break), and a peer that only publishes `face` (an old client) still shows.
- The hidden-tab swap to the raw camera keeps `face-128`/`face-64` at their sizes (`scaleResolutionDownBy`) and is undone when visible.
- Turning back toward someone shows their last frame immediately (paused face), never the avatar flash.
- A muted mic, the boombox and early media (6b rules) keep working with explicit subscriptions.

---

### Task 1: The rule (`media/interest.ts`)

**Produces:**
- `type VideoWant = 'off' | 64 | 128 | 256`
- `interface Want { video: VideoWant; audio: boolean }`
- `interface PeerFacts { drawnColumns: number; projectedSize: number }`
- `interface InterestInput { now: number; hidden: boolean; player: PlayerState; fov: number; map: GameMap; maxDistance: number; peers: readonly { id: string; x: number; y: number }[]; facts: (id: string) => PeerFacts | undefined }`
- `createInterest(): { update(input: InterestInput): ReadonlyMap<string, Want> }` (stateful for holds and hysteresis; forgets peers no longer listed)
- The constants above.

- [ ] Tests (`interest.test.ts`), each named after its rule:
  - drawn → video by size thresholds;
  - hysteresis at 128 and 48 (no flapping within ±20%);
  - downgrade and off only after `HOLD_MS`; upgrade immediate;
  - look-ahead: in the widened view and in line of sight → 64;
  - behind a wall (no line of sight) → off;
  - beyond 20 tiles → off;
  - behind the player → off;
  - hidden → all video off at once, audio kept;
  - audio on ≤ max+2, kept until > max+4, off beyond;
  - caps: 13th-nearest video and 25th-nearest voice off;
  - a peer that disappears from `peers` is forgotten.
- [ ] Implement, run `pnpm --filter @zoom3d/web test interest`, commit `feat(web): interest rule for dynamic subscription`.

### Task 2: Renderer facts (`renderer/sprites.ts`)

**Consumes:** `PeerFacts`. **Produces:**
- `Sprite` gains `key: string`;
- `renderSprites(fb, p, sprites, facts?: Map<string, PeerFacts>)` writes `drawnColumns` and `projectedSize` for every sprite: 0/0 when behind the camera or culled. Objects are reused (created once per key).

- [ ] Tests on a real framebuffer and map:
  - in open view → columns > 0 and size ≈ projection;
  - behind a wall → 0 columns;
  - half behind a corner → some columns;
  - behind the camera → 0;
  - the facts object for a key is the same object across frames (no allocations).
- [ ] Implement, run the renderer tests and `pnpm bench` (no regression beyond noise), commit.

### Task 3: Small face tracks in the framer (`media/framer.ts`)

**Produces:** `Framer.tracks: { 256: MediaStreamTrack; 128: MediaStreamTrack; 64: MediaStreamTrack }` (canvas tracks; 128 and 64 drawn from the 256 canvas each frame step). `Framer.sendTracks()` returns the same shape: the raw camera for all three while hidden, else the canvas tracks. `onSendTrackChange` fires as today.

- [ ] Tests:
  - the small canvases are drawn after each frame step at their sizes;
  - hidden → camera for all three;
  - visible → canvases;
  - camera off → all disabled.
- [ ] Implement, commit.

### Task 4: Transport (`media/livekit.ts`, `media/transport.ts`)

**Consumes:** `Want`, `Framer.sendTracks()` shape. **Produces:**
- `MediaTransport.setVideoTracks(tracks: { 256: MediaStreamTrack; 128: MediaStreamTrack; 64: MediaStreamTrack })` replaces `setVideoTrack`;
- `MediaTransport.setWanted(peerId: string, want: Want): void`;
- `connect`/`disconnect` are removed.

- [ ] Tests (the fake room gains remote publications with `setSubscribed` and the three face names):
  - publishes three face tracks with their options;
  - `dynacast: true`, `autoSubscribe: false`;
  - `setWanted(video 128)` subscribes only `face-128`;
  - a switch 128→256 keeps 128 until 256's track arrives, then emits the stream with 256 and unsubscribes 128;
  - video off unsubscribes the face;
  - audio false unsubscribes `mic` and `boombox`;
  - a peer publishing only `face` gets `face` for any size;
  - with the raw camera (hidden), `face-128`/`face-64` senders get `scaleResolutionDownBy` from the camera's size, reset when canvases return;
  - a muted mic stays muted; early media still works.
- [ ] Implement, commit.

### Task 5: Faces and call (`media/faces.ts`, `media/call.ts`)

**Produces:**
- `FaceSource.setPaused(paused: boolean)`: while paused, `texels` keeps the last live frame instead of falling back after `FACE_STALL_MS`;
- `Call.setWanted(peerId, want)`: forwards to the transport and sets the face paused when `want.video === 'off'`.

- [ ] Tests:
  - paused keeps the last frame past the stall;
  - unpaused with no frames falls back as today;
  - a never-seen peer shows the avatar while paused;
  - call forwards wants and pauses faces;
  - framer track changes reach `setVideoTracks`.
- [ ] Implement, commit.

### Task 6: Wiring and e2e (`main.ts`, `e2e/subscription.spec.ts`)

- [ ] `main.ts`:
  - sprites get `key = peer id`;
  - a reused `facts` map is passed to `renderSprites`;
  - every `INTEREST_MS` (frame loop, plus the hidden-tab ticker when hidden) run `interest.update(...)` and call `call.setWanted` for changed wants.
- [ ] E2E:
  - two people: Bob turns 180° → after ~1 s Ada's video bytes at Bob stop growing; he turns back → they grow again (via `__game.call.stats`);
  - the face never goes blank while turning back (texels non-zero).
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` all green. Commit.

### Task 7: Docs

- [ ] D21: 6c decided as separate tracks (spike), with the constants.
- [ ] AGENTS.md: gotchas for the three face tracks, dynacast on, explicit subscriptions.
- [ ] LiveKit spec §4: a pointer to this spec.
- [ ] Roadmap: 6c ✅ after merge.
- [ ] Commit.
