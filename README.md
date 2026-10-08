# zoom3d

A browser-based retro ray-casting (Wolfenstein 3D style) multiplayer meeting room.

Invited participants join a maze-like map as round avatars showing their live camera
face (streamed over WebRTC). Everyone walks around; audio is spatialised — volume,
panning and room reverb depend on distance and position, so voices sound like they
come from people standing in the room.

**Status:** milestone 1 done. Single-player walk through the level in a fixed 16:9 retro
ray-cast view, with an automap (M/Tab). Multiplayer, faces and spatial audio are next; see
the [roadmap](docs/roadmap.md).

## Quick start

Requires Node ≥ 22 and pnpm 9.

```bash
pnpm install
pnpm dev        # http://localhost:5173 — WASD/arrows to move, click for mouse look, M for the map
pnpm test       # unit tests
pnpm e2e        # Playwright (uses the installed Google Chrome)
```

## Docs

- [docs/vision.md](docs/vision.md) — product goals, scope, non-goals
- [docs/superpowers/specs/2026-10-08-zoom3d-design.md](docs/superpowers/specs/2026-10-08-zoom3d-design.md) — design spec
- [docs/open-decisions.md](docs/open-decisions.md) — decision log: open questions and resolved ones
- [docs/roadmap.md](docs/roadmap.md) — proposed milestones
- [AGENTS.md](AGENTS.md) — guidance for AI coding agents working in this repo
