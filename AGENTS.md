# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## Project

zoom3d: browser retro ray-casting multiplayer meeting room. Participants are avatars whose
"sprite" is their live camera face (WebRTC through a LiveKit SFU). Audio is spatialised with Web Audio (distance
gain, pan, reverb). Read [docs/vision.md](docs/vision.md) first.

## Status

Milestones M1 (single-player walk) and M2 (multiplayer presence) are done. The design spec is [docs/superpowers/specs/2026-10-08-zoom3d-design.md](docs/superpowers/specs/2026-10-08-zoom3d-design.md); also check
[docs/open-decisions.md](docs/open-decisions.md) before assuming anything. Resolved
decisions are recorded there with date and rationale; update it when a decision is made.

## Working agreements

- Docs are the source of truth for decisions. If code and docs diverge, fix one in the same change.
- Record every non-trivial decision in `docs/open-decisions.md` (move from Open to Resolved).
- Keep changes surgical; no speculative features (YAGNI). The map has no interactive elements yet.
- Write a failing test first for logic (raycaster math, audio gain curves, protocol, collision).
  Rendering/WebRTC glue is verified manually or with Playwright (fake media devices).
- Code style is Biome's formatter (`biome.json`): 120 columns, single quotes, semicolons, `es5` trailing
  commas, matching the Prettier style of github.com/pyldin601/maisumtuga. Run `pnpm exec biome check --write .`.
- Every `if`/`else`/`for`/`while` body is a braced block, even one-liners (`style/useBlockStatements`):
  write `if (x) {\n  y();\n}`, never `if (x) y();`.
- Readability conventions are in [docs/code-style.md](docs/code-style.md): names with units, tagged unions over
  mode flags, `.at()` over `arr[i] as T`, small named stages, and behaviour-preserving refactors proven by a trace.
- Commit small, imperative-mood messages. Don't commit secrets or `.env`.
- Never block the render loop: no allocations in the per-frame/per-column hot path.

## Intended layout (see design spec §3)

```
apps/web/        browser client (renderer, input, audio, webrtc)
apps/server/     Node ws server: rooms (Lobby), protocol validation, rate limit, heartbeat
packages/shared/ protocol types, map format, constants
docs/            vision, architecture, decisions, roadmap
```

## Commands

Node ≥ 22, pnpm 12, and `brew install livekit` (local SFU for `pnpm dev` and `pnpm e2e`).

```
pnpm install      # install workspace deps
pnpm dev          # livekit-server --dev :7880 + server :8787 + web app http://localhost:5173 (Vite proxies /ws)
pnpm test         # vitest, all projects
pnpm typecheck    # tsc --noEmit per package
pnpm lint         # biome check
pnpm e2e          # playwright; starts its own LiveKit :7890-7892 + server :8788 + web :5174
pnpm bench        # renderer frame-time benchmark (vitest, unlit walls and sprites)
pnpm bench:walls  # lit walls, reflections and glow in an esbuild bundle, with pixel hashes for refactors
# Large rooms: open /?bots=100 and start a party: the room gets 100 server-driven bots (any server, prod included)
docker compose up --build              # both images locally: http://localhost:8080
scripts/smoke-image.sh server|web IMG  # smoke-test a built image (CI runs this before pushing)
```

## Containers

- `apps/server/Dockerfile` and `apps/web/Dockerfile` build from the **repo root** context.
- The server image runs one esbuild bundle (`pnpm --filter @zoom3d/server build`), so any new
  runtime dependency must be bundleable (or marked external and installed).
- The web image renders `apps/web/nginx/default.conf.template` at start. Only env vars are
  substituted, and `/ws` resolves `SERVER_URL` per request, so nginx starts without the server.
- Restart survival: with `STATE_FILE` set, the server saves the lobby there on SIGTERM and restores it (then deletes
  the file) on start; unset, nothing is written. Production needs `Recreate` deploys (never two pods at once), a
  volume at the file's directory and `fsGroup: 1000` (the image runs as `node`). The snapshot format is
  versioned (`LobbySnapshot` in `apps/server/src/lobby.ts`): bump it when `Peer` changes in a way
  `parsePeerInfo` defaults can't absorb.
- Media goes through LiveKit (spec `docs/superpowers/specs/2026-10-11-livekit-sfu-design.md`). The server signs a
  token per peer and needs `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. In production (`NODE_ENV=production`,
  as in the image) it refuses to start without all three; elsewhere each defaults to `livekit-server --dev`
  (`ws://localhost:7880`, `devkey`, `secret`). On casa they come from the `livekit-keys` SealedSecret.
- `.github/workflows/docker.yml`: every PR builds + smoke-tests; PRs from this repo also push a moving `pr-<N>` preview
  tag (forks never push); `main`/`v*` push `latest`/`sha-<commit>`/semver to GHCR.
- Observability (decision D20): the server logs JSON lines (`LOG_LEVEL`), serves Prometheus metrics at `/metrics`
  (not routed publicly), and reports to Sentry when `SENTRY_DSN` is set. The web image takes `VITE_SENTRY_DSN`,
  `VITE_AMPLITUDE_API_KEY` and `VITE_RELEASE` as build args; CI passes them, and unset leaves both off.
- `.github/workflows/checks.yml`: `pnpm typecheck`, `pnpm lint`, `pnpm test` on every PR and push to `main`
  (e2e is local only).

## Gotchas to remember

- Browsers require a user gesture before `AudioContext` starts; `getUserMedia` needs HTTPS (or localhost).
- Chrome only delivers remote WebRTC audio into Web Audio if the stream is also attached to a (muted) `<audio>` element.
- Echo: use `echoCancellation` on capture and avoid playing remote audio through paths that bypass it.
- LiveKit (`media/livekit.ts`): our tracks are published by **name** (`face`, `face-128`, `face-64`, `mic`,
  `boombox`) as user-provided tracks, and swapped with `replaceTrack`. LiveKit stops local tracks on disconnect by
  default, which would kill the controller's mic and canvas for good: keep `stopLocalTrackOnUnpublish: false` and
  `disconnect(false)`. It also rewrites `enabled` on publish/replace (a muted mic would go live), so the transport
  restores it. Match remote tracks by name, never by order.
- Dynamic subscription (6c spec `docs/superpowers/specs/2026-10-11-dynamic-subscription-design.md`): nothing is
  received until asked for (`autoSubscribe: false`). Every 250 ms `main.ts` runs `media/interest.ts` on what
  `renderSprites` drew (its `facts` map) and hands changed wants to `call.setWanted`. The face's three sizes are
  **separate tracks**, not simulcast (livekit-client disables simulcast below 480 px); dynacast pauses the ones nobody
  receives. Size switches are make-before-break, and faces hold their last frame while paused or resuming. An e2e
  spec that expects someone's face must turn toward them first (`lookAt` in `e2e/join.ts`): players spawn facing a
  random direction.
- A peer's face and voice arrive as **separate** streams (`onRemoteStream` with the shown face, `onRemoteVoice` with
  the mic, played from its own muted `<audio>` like the boombox), each re-emitted as a **new** `MediaStream` when its
  track changes (empty when it goes). The audio engine ignores a stream object it already has (mutating one would
  leave a late mic silent) and rebuilds a voice for a new one, so face changes, which 6c makes constant, must never
  re-emit the voice.
- LiveKit can deliver a peer's tracks before the game WebSocket announces the peer, and never sends them again:
  `call.ts` keeps such early media until the face exists. Don't drop it.
- k8s: a pod next to a Service named `livekit` gets `LIVEKIT_PORT=tcp://…` and LiveKit reads every `LIVEKIT_*` env as
  a setting. The casa Deployment sets `enableServiceLinks: false`.
- Browsers allow one CONNECTING WebSocket per host, so a single hung handshake blocks every retry in every
  tab. In prod, while the server restarts, Traefik drops the `/ws` route and it falls through to the web nginx,
  whose connect to the endpoint-less Service hangs. Keep nginx's `proxy_connect_timeout` short and the client's
  welcome deadline (`connection.ts`) in place.
- E2E runs Chrome with `--use-fake-device-for-media-stream`; `window.__game.call` exposes `isLive`/`stats` (dev only).
  `e2e/mobile.spec.ts` emulates a portrait phone (`hasTouch`, `isMobile`), which Chrome reports as `(pointer: coarse)`.
- Touch mode (mobile spec §2.0) is `matchMedia('(pointer: coarse)')` read once at load (`TOUCH` in `main.ts`, plus
  `html.touch` for CSS). Never re-evaluate it: the frame size, FOV and room UI would flip mid-visit. The FOV lives on
  the `Framebuffer` (`fb.fov`); every projection reads it, so never reintroduce a FOV constant. The buffer is rebuilt
  only when the frame's size or FOV changes, never per frame.
- iOS: `navigator.audioSession.type = 'play-and-record'` (set in `openLobby`, before capture) keeps Web Audio audible
  with the ringer switch on silent. Pointer lock is requested only for `pointerType === 'mouse'`. Touch-mode relayouts
  are held back while a text field has focus (the on-screen keyboard resizes the visual viewport) and replayed on
  focusout.
- Frame rate: the remote `<video>` container must be `visibility: hidden` (not `opacity`). A
  playing video Chrome considers visible paces the whole page to 30 fps (guarded by `e2e/frame-rate.spec.ts`).
- Audio: remote `<video>` elements must stay **muted but playing**. Chrome only feeds WebRTC
  audio into Web Audio while the stream plays in an element; the spatial engine (`apps/web/src/audio/engine.ts`)
  is the only thing that should be audible. The `AudioContext` is created when the lobby opens
  (for the mic meter) and `resume()`d synchronously in the Join submit, before anything else, to satisfy autoplay policy.
- Face framing: the sent video is a canvas track drawn on `requestVideoFrameCallback`, which stops in hidden
  tabs. `framer.sendTracks()` flips all three face tracks to the raw camera while hidden (the small ones scale it
  down) and the call pushes them to the transport;
  don't remove that swap, or peers freeze on tab switch.
- Camera off stops the camera, but the framer's canvas track is always sent (lobby spec §4.3). Don't send the raw
  camera directly or drop the canvas track when the camera is off: the face would be unpublished, and turning the
  camera on would have to republish it. `LocalMediaController` (`media/local-media.ts`) owns every local track
  from the lobby onward; the room never calls `getUserMedia` itself.
- Bots (`?bots=N`, `bots.ts`, `Lobby.spawnBots`/`stepWorld`): server-side peers with a `bot` flag, no connection and no media.
  They never count toward `MAX_PEERS`, never expire, can't be resumed into, aren't saved in the state file, and never
  keep a room open (it closes with its last person). At most `MAX_BOT_ROOMS` rooms have them at once. They move every
  fan-out tick and go out in the same `peers` batches as players, so they exercise the real fan-out.
- State fan-out (6d spec `docs/superpowers/specs/2026-10-11-server-fan-out-design.md`): `Lobby.state()` only stores
  and validates. One 66 ms timer runs `stepWorld` then `fanOut`, which sends each person one `peers` batch of changed
  poses (`fanout.ts`: near ≤ 16 tiles every tick, far every 500 ms), keyed by per-room `slot`s that are never reused. A
  welcome or `peer_joined` counts as sent, so tracking resets there. Clients draw each peer at its tier's delay
  (`net/peer-delay.ts`) and hold the last pose before an update that follows a pause; never go back to one global
  `INTERP_DELAY_MS` for peers. Each entry carries its `age` (ms since the server accepted it), and the client stamps it
  `arrival − age`: arrival times sit on the tick grid, and with two drifting 66 ms timers that grid makes walkers
  stutter (D23). Keep the near delay at two ticks plus jitter (150 ms).
- Avatars travel as ids (`isAvatarId`) and load from `/avatar/<id>` (server `AvatarStore`, ref-counted; nginx and Vite
  proxy the path). The snapshot keeps the data URL, so `LobbySnapshot` is still version 1.
- Protocol version: joins carry `v: PROTOCOL_VERSION`. Bump it on a breaking wire change: older tabs then get the fatal
  `outdated` error and are told to reload (a join with no `v` at all gets `invalid_room`).
- World objects (decision D22, robot vacuum spec `docs/superpowers/specs/2026-10-11-robot-vacuum-design.md`):
  - **Not peers.** `object_state`, `welcome.objects`, `session.objects` and `objectKey(id)` keep them apart from peers:
    no labels, automap, `MAX_PEERS` or media, and they never keep a room open.
  - **The vacuum:** the server steps it in `Lobby.stepWorld` (the pure sim is `packages/shared/src/objects/vacuum/`,
    shared with the landing page), bumping connected people only. It is saved in the state file, keyed by `mapFingerprint`. `VACUUM_NEARLY_DONE=1` (ignored in
    production) starts it one patch from done, so its dock search shows within a minute.
  - **Drawing:** voxel models (`renderer/models/`) are drawn by `renderer/voxels.ts` inside `renderSprites`, far to
    near with the discs.
  - **Sound:** the hum goes through `AudioEngine.attachNode`, not a `MediaStream`, and stays under voices
    (`VACUUM_GAIN`).
- Telemetry privacy: logs, metrics labels, Sentry and Amplitude never get names, resume tokens or IPs, nor raw room
  ids: a room link is the room's only key. Server logs use `roomRef()` (a short hash), and the browser Sentry
  `beforeSend` scrubs `/r/<id>`.
  Add an analytics event by extending `AnalyticsEvent` in `apps/web/src/telemetry/analytics.ts`. Analytics must stay
  storage-free (no cookies, localStorage or sessionStorage; that's why no consent banner is needed), so "Start a party"
  is an in-page `pushState`, not a page load. Keep `public/privacy.html` in step with what is collected.
- Playwright file choosers: start `page.waitForEvent('filechooser')` before the action that opens one, with a
  step in between. Interception turns on asynchronously, and a dialog opened right away can go unseen.
