# Roadmap

Authoritative order: §12 of the [design spec](superpowers/specs/2026-10-08-zoom3d-design.md).
Each step gets its own implementation plan in `docs/superpowers/plans/`.

| # | Step | Outcome |
|---|------|---------|
| 0 | Audio spike (throwaway) | Verdict on echo cancellation with Web Audio (risk R1) |
| 1 | M0+M1 Single-player walk | Tooling, converted map, raycaster, movement, automap |
| 2 | M2 Presence | Server, protocol, join flow, disc avatars, reconnect |
| 3 | M3 Faces | Capture, mesh WebRTC, TURN creds, face billboards |
| 4 | M4 Spatial audio | Distance/pan/reverb, wall muffling, speaking ring, debug panel |
| 5 | M5 Polish | Device pickers, error states, perf, Firefox |
| 6 | M6 Deploy | VPS, HTTPS, coturn |
