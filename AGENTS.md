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
- `.github/workflows/docker.yml`: PRs build + smoke-test only; `main`/`v*` also push to GHCR.

## Gotchas to remember

- Browsers require a user gesture before `AudioContext` starts; `getUserMedia` needs HTTPS (or localhost).
- Chrome only delivers remote WebRTC audio into Web Audio if the stream is also attached to a (muted) `<audio>` element.
- Echo: use `echoCancellation` on capture and avoid playing remote audio through paths that bypass it.
- WebRTC: only the greater peer id initiates (see spec §8). Don't add initiators on both sides:
  rollback during ICE gathering silently kills candidate gathering in Chrome.
- E2E runs Chrome with `--use-fake-device-for-media-stream`; `window.__game.call` exposes `isLive`/`stats` (dev only).
- Frame rate: the remote `<video>` container must be `visibility: hidden` (not `opacity`). A
  playing video Chrome considers visible paces the whole page to 30 fps (guarded by `e2e/frame-rate.spec.ts`).
- Audio: remote `<video>` elements must stay **muted but playing**. Chrome only feeds WebRTC
  audio into Web Audio while the stream plays in an element; the spatial engine (`apps/web/src/audio/engine.ts`)
  is the only thing that should be audible. The `AudioContext` is created synchronously in the
  Join click handler (before any `await`) to satisfy autoplay policy.
