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
```

## Gotchas to remember

- Browsers require a user gesture before `AudioContext` starts; `getUserMedia` needs HTTPS (or localhost).
- Chrome only delivers remote WebRTC audio into Web Audio if the stream is also attached to a (muted) `<audio>` element.
- Echo: use `echoCancellation` on capture and avoid playing remote audio through paths that bypass it.
- WebRTC: only the greater peer id initiates (see spec §8). Don't add initiators on both sides:
  rollback during ICE gathering silently kills candidate gathering in Chrome.
- E2E runs Chrome with `--use-fake-device-for-media-stream`; `window.__game.call` exposes `isLive`/`stats` (dev only).
