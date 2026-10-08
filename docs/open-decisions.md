# Decision log

Format: **ID — question** · options · recommendation. Move to *Resolved* with date + rationale.

## Open

### D1 — Media topology
- **Mesh (P2P)**: no media server, simplest, cheapest. Upload cost grows with N-1 streams; fine to ~6–8 when faces are tiny (≤160 px, ~15 fps).
- **SFU** (LiveKit / mediasoup): scales to dozens, simulcast, server-side bandwidth control. More infra.
- **Rec:** start with mesh behind a thin `MediaTransport` interface; swap to LiveKit if we outgrow it.
- *Partially resolved 2026-10-08:* target group size is 2–8 participants for v1, so mesh is viable. Final call pending design approval.
- *Resolved 2026-10-08 (M3):* mesh implemented behind `MediaTransport` (`apps/web/src/media/mesh.ts`). Single initiator (greater id offers), perfect negotiation for renegotiation, 150 kbps video cap.

### D2 — Renderer
- **Canvas2D software raycaster** (ImageData): authentic, fully controllable, CPU-bound at higher res.
- **WebGL/WebGPU shader raycaster**: fast, video as texture trivially, easy CRT/post effects.
- **Rec:** Canvas2D at low res first (matches the retro aesthetic, easiest to test as pure functions); sprites via `drawImage`. Revisit if effects/perf need GPU.
- *Resolved-pending-spec 2026-10-08:* Canvas2D software raycaster.

### D3 — Backend stack
- Node + TypeScript + `ws` (or Fastify + `@fastify/websocket`), in-memory rooms. Shares types with client.
- Alternatives: Go, Elixir/Phoenix channels, Cloudflare Durable Objects (one DO per room — attractive for rooms).
- **Rec:** Node/TS monorepo for v1.
- *Resolved-pending-spec 2026-10-08:* Node/TS monorepo, self-hosted VPS (coturn for TURN). Also narrows D11.

### D4 — Position authority
- Client-authoritative (server relays, clamps speed) vs server-authoritative (server runs collision).
- **Rec:** client-authoritative with server sanity checks; it's a meeting, not a competitive game.

### D5 — Spatial audio approach
- Web Audio `PannerNode` (HRTF) + custom distance curve + shared `ConvolverNode` reverb with distance-driven wet/dry.
- vs. fully custom DSP in an AudioWorklet (more control, more work).
- **Rec:** native nodes first. Headphones vs speakers matters (HRTF only good on headphones).

### D6 — Audio realism features
- Wall occlusion (low-pass when line of sight blocked)? Hear-through-walls at all?
- Max audible range / "whisper zones"?
- **Rec:** occlusion as a later milestone; hard range cut-off in v1.
- *Resolved-pending-spec 2026-10-08:* muffle through walls (low-pass + extra attenuation when line of sight is blocked); supersedes the "later milestone" rec, so move it into milestone 4.

### D7 — Face capture
- Raw camera square-crop vs face-detected crop (MediaPipe / `FaceDetector`) vs background removal.
- Resolution/fps budget per avatar; behaviour when camera is off (initials/colour disc, or static avatar).
- **Rec:** center square crop v1, optional face tracking later.
- *Resolved-pending-spec 2026-10-08:* centre square crop (~128 px, ~15 fps, round mask); camera off/denied shows a coloured disc with initials; mic-only join allowed.
- *Resolved 2026-10-09:* camera off shows an optional static avatar picture (128×128 JPEG, relayed by the server in `join`/`Peer`, stored in `localStorage`), else initials. Spec §8.1.

### D8 — Rooms, invites, identity
- Invite = unguessable URL (token) vs signed JWT with expiry vs accounts. Room lifetime (ephemeral vs persistent)? Display names? Host powers (kick, mute)?
- **Rec:** ephemeral rooms, unguessable link, display name only.
- *Resolved-pending-spec 2026-10-08:* as recommended. Host controls (kick/mute/lock) deferred.

### D9 — Maps
- Hand-made grid in JSON/ASCII vs procedural maze per room. One map or selectable? Textures: generated vs asset pack (licensing).
- **Rec:** one hand-made ASCII map to start; procedural later.
- *Resolved-pending-spec 2026-10-08:* use the Wolfenstein-style level in `docs/assets/map-reference.png` as the v1 map. Secret rooms (green walls) are ignored, i.e. treated as plain solid wall. Converting the image to the grid JSON/ASCII format is part of milestone 1.
- Colours: grey, brown and blue walls become three wall types/textures (zones). Green secret-door squares become plain wall of the surrounding type. Red/yellow squares are ordinary tiles; the blue diamond marks a spawn point. Pixel-to-tile scale (image is 505x456, likely 64x57 tiles at ~8 px) to be verified during conversion.

### D10 — Tooling
- pnpm workspaces + Vite + Vitest + Playwright + ESLint/Biome, TypeScript strict.
- **Rec:** accept as proposed.

### D11 — Hosting / deployment
- Needs HTTPS (getUserMedia) and likely TURN (coturn or a hosted one). Where will it run?

### D12 — Input and accessibility
- Keyboard only vs mouse-look vs touch. Colour-blind/readable names above avatars? Captions?

### D13 — Findability
- *Resolved-pending-spec 2026-10-08:* shared spawn near the blue-diamond start + toggleable automap showing walls and named participant dots.

### D14 — Aspect ratio
- *Resolved-pending-spec 2026-10-08:* the UI keeps a stable 16:9 aspect ratio: letterboxed game viewport, fixed FOV, HUD and overlays anchored to the viewport box. Optional integer-scale mode.

### Risks (to verify, not assume)
- **R1 — Echo cancellation vs Web Audio output.** Chrome's AEC historically did not cancel audio played via `AudioContext`. If still true, speakers echo. Verify in an early throwaway audio spike (speakers vs headphones).
  - *Verdict 2026-10-08 (provisional):* user tested Chrome on both devices with the spike and reported it "sounds good", i.e. no echo problem heard. Interpreted as outcome (a): M4 uses the `webaudio` path (graph → `AudioContext.destination`). The per-mode table was not filled in and **Firefox is untested**, so re-check Firefox (and speakers at higher volume) in M5 before relying on (a) there.
  - *2026-10-08 (M4):* implemented per (a): voices play only through the Web Audio graph to `ctx.destination`. Firefox and speaker echo still to be verified in M5.
- **R2 — Background tabs.** rAF stops in hidden tabs; nothing peers depend on may be driven by the render loop.
- **R3 — Safari** WebRTC/Web Audio quirks; best-effort support.

## Resolved
_(none yet)_
