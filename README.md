# zoom3d

A browser-based retro ray-casting (Wolfenstein 3D style) multiplayer meeting room.

Invited participants join a maze-like map as round avatars showing their live camera
face (streamed over WebRTC). Everyone walks around; audio is spatialised — volume,
panning and room reverb depend on distance and position, so voices sound like they
come from people standing in the room.

**Status:** M4 done. Create a room, share the link, and walk the level together. Avatars show
live camera faces (peer-to-peer WebRTC), or a picture you pick on the join screen while
your camera is off, and voices are spatial: they get quieter with
distance (silent beyond 12 tiles), come from the speaker's direction (HRTF, best on
headphones), get roomier further away, and sound muffled through walls. A ring lights up
around whoever is talking. Press `` ` `` in a room to tune the audio. See the
[roadmap](docs/roadmap.md) for what's next.

## Quick start

Requires Node ≥ 22 and pnpm 9.

```bash
pnpm install
pnpm dev        # server :8787 + http://localhost:5173
pnpm test       # unit tests
pnpm e2e        # Playwright (uses the installed Google Chrome)
```

To try it: open http://localhost:5173, click **Create room**, enter a name, then open the same
room link in a second window (or a second browser) with another name. Controls: WASD/arrows
to move, Q/E or arrows to turn, click the view for mouse look, M or Tab for the automap,
`` ` `` for the audio tuning panel (or add `?debug` to the room URL).
The browser asks for camera and microphone on Join. They only work on `localhost` or HTTPS, so
testing from another device on the LAN needs HTTPS (planned for M6).

## Docker

Each service has its own image, published to GHCR by CI on every push to `main` (`latest`,
`sha-<commit>`) and on `v*` tags (semver):

- `ghcr.io/pyldin601/zoom3d-server`: WebSocket server on port 8787 (`GET /health`).
  Env: `PORT`, `RESUME_GRACE_MS`, `STUN_URLS`, `TURN_URLS`, `TURN_SECRET`, `TURN_TTL_S`.
- `ghcr.io/pyldin601/zoom3d-web`: static app on nginx, port 8080 (`GET /healthz`). It
  proxies `/ws` to `SERVER_URL` (default `http://server:8787`).

Run both locally:

```bash
docker compose up --build
```

Then open http://localhost:8080. Camera and mic need `localhost` or HTTPS.

## Docs

- [docs/vision.md](docs/vision.md) — product goals, scope, non-goals
- [docs/superpowers/specs/2026-10-08-zoom3d-design.md](docs/superpowers/specs/2026-10-08-zoom3d-design.md) — design spec
- [docs/open-decisions.md](docs/open-decisions.md) — decision log: open questions and resolved ones
- [docs/roadmap.md](docs/roadmap.md) — proposed milestones
- [AGENTS.md](AGENTS.md) — guidance for AI coding agents working in this repo
