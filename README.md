# zoom3d

A browser-based retro ray-casting (Wolfenstein 3D style) multiplayer meeting room.

Invited participants join a maze-like map as round avatars showing their live camera
face (streamed over WebRTC). Everyone walks around; audio is spatialised — volume,
panning and room reverb depend on distance and position, so voices sound like they
come from people standing in the room.

**Status:** M2 done. Create a room, share the link, and walk the level together. Other
people show as coloured discs with name labels and dots on the automap. Faces (WebRTC) and
spatial audio are next; see the [roadmap](docs/roadmap.md).

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
to move, Q/E or arrows to turn, click the view for mouse look, M or Tab for the automap.

## Docs

- [docs/vision.md](docs/vision.md) — product goals, scope, non-goals
- [docs/superpowers/specs/2026-10-08-zoom3d-design.md](docs/superpowers/specs/2026-10-08-zoom3d-design.md) — design spec
- [docs/open-decisions.md](docs/open-decisions.md) — decision log: open questions and resolved ones
- [docs/roadmap.md](docs/roadmap.md) — proposed milestones
- [AGENTS.md](AGENTS.md) — guidance for AI coding agents working in this repo
