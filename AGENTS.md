# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## Project

zoom3d: browser retro ray-casting multiplayer meeting room. Participants are avatars whose
"sprite" is their live camera face (WebRTC). Audio is spatialised with Web Audio (distance
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

Node ≥ 22, pnpm 9.

```
pnpm install      # install workspace deps
pnpm dev          # server :8787 + web app http://localhost:5173 (Vite proxies /ws)
pnpm test         # vitest, all projects
pnpm typecheck    # tsc --noEmit per package
pnpm lint         # biome check
pnpm e2e          # playwright; starts its own server :8788 + web :5174
pnpm bench        # renderer frame-time benchmark
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
- `.github/workflows/docker.yml`: PRs build + smoke-test only; `main`/`v*` also push to GHCR.
- Observability (decision D20): the server logs JSON lines (`LOG_LEVEL`), serves Prometheus metrics at `/metrics`
  (not routed publicly), and reports to Sentry when `SENTRY_DSN` is set. The web image takes `VITE_SENTRY_DSN`,
  `VITE_AMPLITUDE_API_KEY` and `VITE_RELEASE` as build args; CI passes them, and unset leaves both off.
- `.github/workflows/checks.yml`: `pnpm typecheck`, `pnpm lint`, `pnpm test` on every PR and push to `main`
  (e2e is local only).

## Gotchas to remember

- Browsers require a user gesture before `AudioContext` starts; `getUserMedia` needs HTTPS (or localhost).
- Chrome only delivers remote WebRTC audio into Web Audio if the stream is also attached to a (muted) `<audio>` element.
- Echo: use `echoCancellation` on capture and avoid playing remote audio through paths that bypass it.
- WebRTC: only the greater peer id initiates (see spec §8). Don't add initiators on both sides:
  rollback during ICE gathering silently kills candidate gathering in Chrome.
- Browsers allow one CONNECTING WebSocket per host, so a single hung handshake blocks every retry in every
  tab. In prod, while the server restarts, Traefik drops the `/ws` route and it falls through to the web nginx,
  whose connect to the endpoint-less Service hangs. Keep nginx's `proxy_connect_timeout` short and the client's
  welcome deadline (`connection.ts`) in place.
- E2E runs Chrome with `--use-fake-device-for-media-stream`; `window.__game.call` exposes `isLive`/`stats` (dev only).
- Frame rate: the remote `<video>` container must be `visibility: hidden` (not `opacity`). A
  playing video Chrome considers visible paces the whole page to 30 fps (guarded by `e2e/frame-rate.spec.ts`).
- Audio: remote `<video>` elements must stay **muted but playing**. Chrome only feeds WebRTC
  audio into Web Audio while the stream plays in an element; the spatial engine (`apps/web/src/audio/engine.ts`)
  is the only thing that should be audible. The `AudioContext` is created when the lobby opens
  (for the mic meter) and `resume()`d synchronously in the Join submit, before anything else, to satisfy autoplay policy.
- Face framing: the sent video is a canvas track drawn on `requestVideoFrameCallback`, which stops in hidden
  tabs. `framer.sendTrack` flips to the raw camera track while hidden and the call pushes it to the mesh;
  don't remove that swap, or peers freeze on tab switch.
- Camera off stops the camera, but the framer's canvas track is always sent (lobby spec §4.3). Don't send the raw
  camera directly or drop the canvas track when the camera is off: the video m-line would go recvonly, and turning
  the camera on would need a renegotiation. `LocalMediaController` (`media/local-media.ts`) owns every local track
  from the lobby onward; the room never calls `getUserMedia` itself.
- Mesh m-line order is fixed: video, mic, boombox (`BOOMBOX_INDEX = 2`). The boombox transceiver is added after
  the mic's `addTrack` (which would otherwise take it) and is only ever swapped with `replaceTrack`; don't add
  transceivers before it or renegotiate to toggle it. Its 128 kbps cap must be set again after the answer:
  Chrome drops parameters set on a trackless sender before then.
- Telemetry privacy: logs, metrics labels, Sentry and Amplitude never get names, resume tokens or IPs, and
  analytics never gets room ids (a room link is the room's only key; the browser Sentry `beforeSend` scrubs them).
  Add an analytics event by extending `AnalyticsEvent` in `apps/web/src/telemetry/analytics.ts`.
- Playwright file choosers: start `page.waitForEvent('filechooser')` before the action that opens one, with a
  step in between. Interception turns on asynchronously, and a dialog opened right away can go unseen.
