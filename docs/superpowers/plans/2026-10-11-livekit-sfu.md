# Media through LiveKit (6b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All audio and video go through the LiveKit SFU instead of the peer-to-peer mesh, with no visible change.

**Architecture:**
- The game server signs a LiveKit token per peer and hands it out in `welcome`.
- The client gets a second `MediaTransport` implementation (`media/livekit.ts`) behind the existing seam in `call.ts`.
- Once the existing e2e suite passes against a local LiveKit, the mesh, the signalling relay and the STUN/TURN config are deleted.

**Tech Stack:** `livekit-client` 2.22.x (web), `livekit-server-sdk` 2.19.x (server), `livekit-server` 1.13.x
(Homebrew, local dev/e2e; casa in prod), TypeScript, Vitest, Playwright.

**Spec:** [docs/superpowers/specs/2026-10-11-livekit-sfu-design.md](../specs/2026-10-11-livekit-sfu-design.md)

## Global Constraints

- Room name = zoom3d room id. Identity = zoom3d peer id. Token TTL 6 h. Grants: `roomJoin`, `canPublish`,
  `canSubscribe` for that room only.
- Env: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
  - Required when `NODE_ENV=production`.
  - Otherwise default to `ws://localhost:7880` / `devkey` / `secret`.
- Track names `face`, `mic`, `boombox`. Match by name only.
- Encodings:
  - face: 350 kbps max, no simulcast;
  - boombox: 128 kbps, DTX and RED off;
  - mic: DTX on.
- Room options: `autoSubscribe: true`, `adaptiveStream: false`, `dynacast: false`.
- Local tracks are user-provided: LiveKit must never stop or re-acquire them (`LocalMediaController` owns them).
- Camera on/off, hidden-tab swaps and mic swaps use `replaceTrack`, never republish.
- Remote elements stay muted but playing; the spatial engine is the only audible path.
- Playwright's LiveKit: ports 7890 (signal), 7891 (TCP), 7892 (UDP). `pnpm dev`'s LiveKit: 7880 (defaults).
- Code style: AGENTS.md (Biome, braces on every body). Failing test first for logic.

## Review Focus

- A peer whose `face` track arrives before `mic` (or without one: no mic) still gets a face, and voice attaches
  when `mic` arrives later, as the same stream object or a re-emitted one the engine accepts.
- Boombox switched on, off, on again: no duplicate publications, and the receiver's boombox element is replaced
  rather than stacked.
- A game reconnect that keeps the identity (resume) must not tear down the LiveKit room. A new identity must.
- A hidden tab swaps the face to the raw camera track, and peers keep receiving (AGENTS "Face framing" gotcha).
- The production server refuses to start without the LiveKit env, so a missing secret fails the rollout instead of
  silently using `devkey`.

---

### Task 1: Server token module

**Files:** Create `apps/server/src/livekit.ts`, `apps/server/src/livekit.test.ts`. Modify `apps/server/package.json`
(add `livekit-server-sdk` 2.19.x).

**Produces:**
- `interface LiveKitConfig { url: string; apiKey: string; apiSecret: string }`
- `liveKitConfigFromEnv(env: Record<string, string | undefined>): LiveKitConfig`: throws `Error('LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required in production')` when `env.NODE_ENV === 'production'` and any is missing.
- `liveKitTokenFor(cfg: LiveKitConfig, roomId: string, peerId: string, nowMs: number): Promise<string>`

- [ ] Tests:
  - Defaults outside production.
  - Production with all three set.
  - Production with any one missing throws.
  - Token verifies with the secret (`TokenVerifier` from the SDK, or `jose`).
  - `sub` = peerId, `video.room` = roomId, `roomJoin`, `canPublish`, `canSubscribe` all true.
  - `exp - nbf` ≈ 6 h.
- [ ] Run (`pnpm --filter @zoom3d/server test livekit`), watch it fail, implement, pass.
- [ ] Check the bundle: `pnpm --filter @zoom3d/server build` succeeds with the SDK bundled by esbuild. If it can't
  be bundled, mark it external and install it in the Dockerfile's runtime stage, per AGENTS.md.
- [ ] Commit `feat(server): sign LiveKit tokens`.

### Task 2: LiveKit transport (not wired yet)

**Files:**
- Create `apps/web/src/media/transport.ts`: move `MediaTransport` here and re-export it from `mesh.ts` so mesh and call compile unchanged.
- Create `apps/web/src/media/livekit.ts`, `apps/web/src/media/livekit.test.ts`.
- Modify `apps/web/package.json` (add `livekit-client` 2.22.x).

**Consumes:** `MediaTransport` (`connect`, `handleSignal`, `disconnect`, `close`, `stats`, `setVideoTrack`,
`setAudioTrack`, `setBoomboxTrack`). `handleSignal` is dropped from the interface in Task 3. Until then
`livekit.ts` implements it as a no-op.

**Produces:** `createLiveKitTransport(opts: { url: string; token: string; localStream: MediaStream | null; onRemoteStream(peerId: string, stream: MediaStream): void; onRemoteBoombox(peerId: string, stream: MediaStream): void; RoomImpl?: typeof Room; createStream?: (tracks: MediaStreamTrack[]) => MediaStream }): MediaTransport`

Before writing it, check the `livekit-client` 2.22 API with Context7, using the names below as a checklist.
Correct these names in the plan only if the docs differ, and record a ledger ruling when they do:
- `new Room({ adaptiveStream, dynacast })`
- `room.connect(url, token, { autoSubscribe })`
- `localParticipant.publishTrack(mediaStreamTrack, { name, source, videoEncoding, simulcast, dtx, red, audioPreset })`
- `LocalTrack.replaceTrack(track, { userProvidedTrack: true })`
- `localParticipant.unpublishTrack(track, stopOnUnpublish=false)`
- `RoomEvent.TrackSubscribed (track, publication, participant)`, `TrackUnsubscribed`, `ParticipantDisconnected`
- `publication.trackName`, `participant.identity`, `RemoteTrack.mediaStreamTrack`, `track.getRTCStatsReport()`

Tests (with a fake `Room` built on an event emitter):
- [ ] Connects with the given url/token and `autoSubscribe: true, adaptiveStream: false, dynacast: false`.
- [ ] Publishes face then mic from `localStream`. Names `face` and `mic`, sources Camera and Microphone, face
  `maxBitrate` 350_000 and `simulcast: false`, mic `dtx: true`. No mic track in the stream means no mic publication.
- [ ] `setVideoTrack(t)` calls `replaceTrack(t, userProvided)` on the face publication and never `publishTrack`
  again. Same for `setAudioTrack` on mic.
- [ ] `setBoomboxTrack`:
  - `t` publishes `boombox` (ScreenShareAudio, 128 kbps, dtx/red off);
  - a second `t2` replaces it;
  - `null` unpublishes without stopping the track;
  - `t3` publishes again.
- [ ] Remote `face` then `mic` for identity `p1` gives one stream holding both tracks: `onRemoteStream('p1', s)` is
  called again after `mic` arrives (Review Focus 1). Remote `boombox` gives `onRemoteBoombox('p1', stream)`.
- [ ] `stats('p1')` sums `inbound-rtp` `bytesReceived` from face+mic into `bytesReceived` and from boombox into
  `boomboxBytesReceived`. It returns `null` for an unknown peer.
- [ ] `close()` disconnects the room. Calls after `close()` are harmless.
- [ ] Implement, pass, lint, commit `feat(web): LiveKit MediaTransport`.

### Task 3: Cutover (protocol, server, client, local LiveKit)

**Files:**
- Modify `packages/shared/src/protocol/protocol.ts` and its test:
  - welcome `livekit: { url, token }` replaces `iceServers`;
  - delete `SignalMessage`, `SignalPayload`, `IceServer`, `parseSignalPayload` and the `signal` client/server cases.
- Modify `apps/server/src/lobby.ts` and `server.ts` and their tests:
  - lobby option `liveKitFor(roomId, peerId): Promise<{ url; token }>` replaces `iceServersFor`; welcome awaits it;
  - delete `signal()` and the relay.
- Modify `apps/server/src/main.ts`: `liveKitConfigFromEnv(process.env)` at start-up.
- Delete `apps/server/src/ice.ts` and its test.
- Modify `apps/web/src/net/session.ts` and its test:
  - `welcome?(selfId, livekit, identityChanged)`;
  - drop `signal` and `sendSignal`.
- Modify `apps/web/src/media/call.ts` and its test:
  - option `createTransport(opts)` replaces `createMesh`;
  - built from `welcome`'s `livekit` on a new identity;
  - a resume with the same identity keeps the transport (Review Focus 3);
  - drop `signal`.
- Modify `apps/web/src/main.ts` to wire `createLiveKitTransport`.
- Delete `media/mesh.ts`, `mesh.test.ts` and `fake-rtc.ts`, keeping `transport.ts` without `handleSignal`.
- Dev and e2e:
  - root `package.json` `dev` also runs `livekit-server --dev`;
  - `apps/web/playwright.config.ts` adds a webServer `livekit-server --dev --config-body '<port 7890, rtc tcp 7891, udp 7892>'` (ready check `http://localhost:7890`) and passes `LIVEKIT_URL=ws://localhost:7890` to its server;
  - `compose.yaml` comment lists the new env.

- [ ] Protocol and server tests first:
  - welcome carries `livekit.url` and a token for the joiner, on first join and on resume;
  - `signal` messages are now invalid;
  - watch them fail, implement.
- [ ] Session and call tests:
  - the welcome passes `livekit` through;
  - a new identity builds a transport with that url/token;
  - a resume with the same identity does not rebuild it.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] `brew list livekit || brew install livekit`, then `pnpm e2e`: **every existing spec passes unchanged**
  (faces, audio, boombox, multiplayer, frame-rate, avatar, mobile, lobby, framing). A failure is a transport bug:
  fix the transport, not the spec. Exception: assertions about mesh internals, each ruled in the ledger.
- [ ] Hidden-tab check (Review Focus 4): the framing/faces e2e covers it. If not, add one e2e that hides A's tab and
  asserts B's face for A keeps receiving bytes.
- [ ] Record the web bundle size before and after (`pnpm --filter @zoom3d/web build`) in the commit message.
- [ ] Commit `feat: media through LiveKit; remove the mesh and WebRTC signalling relay`.

### Task 4: Docs

**Files:** `AGENTS.md`, `README.md`, `docs/open-decisions.md` (D1, D11), `docs/roadmap.md`, design spec §8 pointer.

- [ ] AGENTS.md:
  - Commands: `brew install livekit`, and `pnpm dev` / `pnpm e2e` start it.
  - Containers: the server needs the LiveKit env in prod.
  - Gotchas: replace the mesh ones ("only the greater peer id initiates", "m-line order") with LiveKit ones:
    track names, user-provided tracks, `enableServiceLinks: false` in k8s, muted-but-playing still applies.
- [ ] D1 resolved 2026-10-11: SFU (LiveKit), with the reason. D11: LiveKit on casa, with a link to the servers manifest.
- [ ] Roadmap: a row for "M7 SFU" with 6a ✅, 6b ✅, 6c and 6d pending.
- [ ] Commit `docs: LiveKit media`.

### Task 5: Production rollout (servers repo; ask before pushing)

- [ ] After merge and CI: in `k8s/casa/apps/zoom3d/zoom3d.yaml`, the server container gets `LIVEKIT_URL=wss://lk.pyldin601.xyz`
  plus `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` from secret `livekit-keys`. Bump both image tags in the same commit.
- [ ] Ask the user, push, refresh Argo, `rollout status`.
- [ ] Verify:
  - two browsers in one room see and hear each other;
  - LiveKit logs show the room with both identities;
  - one client on mobile data if the user can.
- [ ] Update the casa memory note: zoom3d uses LiveKit.
