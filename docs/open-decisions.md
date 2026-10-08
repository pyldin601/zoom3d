# Decision log

Format: **ID — question** · options · recommendation. Move to *Resolved* with date + rationale.

## Open

### D1 — Media topology
- **Mesh (P2P)**: no media server, simplest, cheapest. Upload cost grows with N-1 streams; fine to ~6–8 when faces are tiny (≤160 px, ~15 fps).
- **SFU** (LiveKit / mediasoup): scales to dozens, simulcast, server-side bandwidth control. More infra.
- **Rec:** start with mesh behind a thin `MediaTransport` interface; swap to LiveKit if we outgrow it.
- *Partially resolved 2026-10-08:* target group size is 2–8 participants for v1, so mesh is viable. Final call pending design approval.

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

### D7 — Face capture
- Raw camera square-crop vs face-detected crop (MediaPipe / `FaceDetector`) vs background removal.
- Resolution/fps budget per avatar; behaviour when camera is off (initials/colour disc, or static avatar).
- **Rec:** center square crop v1, optional face tracking later.

### D8 — Rooms, invites, identity
- Invite = unguessable URL (token) vs signed JWT with expiry vs accounts. Room lifetime (ephemeral vs persistent)? Display names? Host powers (kick, mute)?
- **Rec:** ephemeral rooms, unguessable link, display name only.

### D9 — Maps
- Hand-made grid in JSON/ASCII vs procedural maze per room. One map or selectable? Textures: generated vs asset pack (licensing).
- **Rec:** one hand-made ASCII map to start; procedural later.

### D10 — Tooling
- pnpm workspaces + Vite + Vitest + Playwright + ESLint/Biome, TypeScript strict.
- **Rec:** accept as proposed.

### D11 — Hosting / deployment
- Needs HTTPS (getUserMedia) and likely TURN (coturn or a hosted one). Where will it run?

### D12 — Input and accessibility
- Keyboard only vs mouse-look vs touch. Colour-blind/readable names above avatars? Captions?

## Resolved
_(none yet)_
