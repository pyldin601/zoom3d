# Roadmap

Authoritative order: §12 of the [design spec](superpowers/specs/2026-10-08-zoom3d-design.md).
Each step gets its own implementation plan in `docs/superpowers/plans/`.

| # | Step | Outcome |
|---|------|---------|
| 0 | Audio spike (throwaway) ✅ | Verdict on echo cancellation with Web Audio (risk R1) |
| 1 | M0+M1 Single-player walk ✅ | Tooling, converted map, raycaster, movement, automap |
| 2 | M2 Presence ✅ | Server, protocol, join flow, disc avatars, reconnect |
| 3 | M3 Faces ✅ | Capture, mesh WebRTC, TURN creds, face billboards |
| 4 | M4 Spatial audio ✅ | Distance/pan/reverb, wall muffling, speaking ring, debug panel |
| 5 | M5 Polish | Device pickers, error states, perf, Firefox |
| 6 | M6 Deploy ✅ | Home k3s (casa) via ArgoCD, HTTPS; TURN comes with LiveKit (D11) |
| 7 | M7 100+ rooms | LiveKit on casa (D21): 6a deploy ✅, 6b media through it ✅, 6c dynamic subscription ✅ (no video for people out of view, no audio beyond hearing range, smaller face tracks for distant faces), 6d server fan-out ✅ (one batch of changed poses per client per tick, far peers twice a second, avatars over HTTP, generated colours, 128 people), 100-person load test ✅ (fits: ~60% node CPU tested, ~80% modelled; uplink unmeasured, [report](load-tests/2026-10-12-m7-100-people.md)) |
