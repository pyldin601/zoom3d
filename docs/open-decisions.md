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
- *Resolved 2026-10-09:* distance curve is physical. Dry follows 1/d (−6 dB per doubling) and the reverb send is 0.4/√d (−3 dB per doubling). Both fade to silence over the last quarter of `max`, and `max` goes from 12 to 24 tiles. Why: the old quadratic curve had almost no reverb up close (a near voice sounded "in my room"), and it dropped the reverb together with the voice, so silence came too soon. Spec §9.2. The storage key was bumped to `zoom3d.audio.v2` so the old saved `max: 12` doesn't hide the new default.

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
- *Amended 2026-10-09:* face framing. The sender captures 640×480 and runs MediaPipe Face Detector (BlazeFace, self-hosted wasm) at about 5 Hz. A smoothed square around the face is drawn to a 256² canvas, and its `captureStream` is the outgoing track, so peers see a centred face at a consistent size. It's always on with no UI. No face or no model means the old centre crop. In a hidden tab the senders swap to the raw camera track, because the canvas would freeze. Receivers are unchanged. Spec: [2026-10-09-face-framing-design.md](superpowers/specs/2026-10-09-face-framing-design.md). *Amended 2026-10-09:* detection runs once a second instead of about 5 times: seated people rarely move and the dead zone ignores small moves, so this cuts main-thread cost 5× for up to ~1 s of lag. The lost-face timeout went from 1.5 s to 3 s (still about 3 missed detections) and easing from 300 ms to 600 ms, so the crop glides between once-a-second targets instead of jumping. *Amended 2026-10-09:* when BlazeFace reports the mouth keypoint, the crop is placed so the mouth sits at the centre column, 72% of the way down (`MOUTH_Y_IN_CROP = 0.72` in `framing.ts`); size still comes from the face box. That makes the mouth's place on every disc a known constant, so the held-items sip lands on the mouth for any face. Without the keypoint the old box-centre-plus-headroom rule applies. *Amended 2026-10-09:* the last framing is remembered per camera (localStorage, keyed by `deviceId` and frame size) and a page reload or camera switch starts from it, held until the detector has loaded. Before, every reload started centred and jumped to the face once the model loaded, which peers saw too.

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
- *Resolved 2026-10-09:* Biome only (lint + format), no ESLint/Prettier. Code style follows the Prettier config of github.com/pyldin601/maisumtuga: 120 columns, single quotes, semicolons, `es5` trailing commas, 2-space indent. Control-flow bodies always use braces (`style/useBlockStatements`, like ESLint `curly`).

### D11 — Hosting / deployment
- Needs HTTPS (getUserMedia) and likely TURN (coturn or a hosted one). Where will it run?
- *Resolved 2026-10-09 (restarts only):* rooms survive a server restart. The server runs as one replica with the
  k8s `Recreate` strategy. On SIGTERM it writes the lobby to `STATE_FILE` on a persistent volume, and the next
  process reads the file at start-up and deletes it. Every restored slot gets a fresh grace period, so clients
  resume with the same id and keep their P2P mesh. We rejected Redis plus a per-room lease (which rolling deploys
  need, to avoid two pods serving one room) as too much machinery. With `Recreate`, the restart gap is covered by
  the 30 s grace period, and media between peers never stops. Long-term persistence stays out of scope.

### D12 — Input and accessibility
- Keyboard only vs mouse-look vs touch. Colour-blind/readable names above avatars? Captions?

### D13 — Findability
- *Resolved-pending-spec 2026-10-08:* shared spawn near the blue-diamond start + toggleable automap showing walls and named participant dots.

### D14 — Aspect ratio
- *Resolved-pending-spec 2026-10-08:* the UI keeps a stable 16:9 aspect ratio: letterboxed game viewport, fixed FOV, HUD and overlays anchored to the viewport box. Optional integer-scale mode.

### D15 — Held items
- How an avatar shows a drink in hand, and how the choice syncs.
- *Resolved 2026-10-09:* a floating hand with no arm on the viewer's right of the disc. Mugs are held by the handle, which faces the disc; wine by the stem. It shows on the avatar only, with no first-person view. Items for v1: nothing, beer, coffee, wine, picked from a `<select>` in the room bar and remembered in `localStorage`. It syncs through its own `held` / `peer_held` messages plus `Peer.held`, not inside `media`, so a cosmetic item is never tied to mic/cam state. Server → client parsing reads unknown items as `null`, so items can be added later without breaking older clients. Spec: [2026-10-09-held-items-design.md](superpowers/specs/2026-10-09-held-items-design.md). *Amended 2026-10-09:* the item casts its own small floor shadow under it, the same style as the disc's, so it reads as being in the room rather than pasted on (spec §2). *Amended 2026-10-09:* the hand and drink moved in front of the disc's lower right (left edge at +0.15 r, top 0.3 r below the horizon), so the drink is held against the body instead of floating beside it. *Amended 2026-10-09:* first person is now in scope. You see your own drink peeking in at the bottom-left, in your left hand to match what others see. Avatars bob while walking, with their drink swinging half a step behind; the bob comes from distance walked, so it needs no protocol change (spec §2.1–2.2). *Amended 2026-10-09:* pressing the key of the drink you already hold takes a sip. You see the drink sink towards your mouth at the bottom-centre, and others see it go up to your disc's mouth. A sip is a one-off `drink` → `peer_drink` event, never stored, relayed at most once per second per player (spec §2.3). *Amended 2026-10-09:* the room-bar `<select>` picker is gone; drinks are picked only with the number keys (`1`–`3`, `0` for nothing), which made it redundant (spec §6.3). *Amended 2026-10-09:* drinks are held from the outside: the drink sits next to the disc and the fist (on the mug's handle or the wine's stem) is on the far side. Your own first-person drink flips to match, with the hand toward the screen edge (spec §2, §2.1). *Amended 2026-10-10:* the fist on the beer and the coffee shrank from 7×6 texels (as wide as the mug) to 4×5, wrapped around the mug's side, so the drink reads first. The mugs, their place by the disc and the sip point are unchanged; the item's floor shadow, sized from the sprite width, shrinks with it (spec §2). *Amended 2026-10-10:* holding the held drink's key for 500 ms raises it in a cheers instead of sipping: the drink goes up over the head (and up into full view in first person) for 1.6 s with a small wobble, no sound. A quick press still sips, now on release. It is a one-off `cheers` → `peer_cheers` event like the sip, sharing the sip's 1 s relay gap, since a player makes one gesture at a time (spec §2.4).

### D16 — Boombox
- How a player plays music to the room, and how it shows.
- *Resolved 2026-10-09:* `B` opens a file picker and the track plays once; `B` again or
  the track ending stops it. The music is a third, pre-allocated `sendrecv` audio transceiver on each mesh
  connection, switched with `replaceTrack`, so it never renegotiates. Listeners spatialise it from the
  carrier's position through the voice engine, as mono Opus at 128 kbps (sender `maxBitrate`; the 32 kbps
  speech default smears music, and a spatial point source folds stereo anyway). Only an on/off flag goes through the server
  (`boombox` / `peer_boombox` / `Peer.boombox`), for the sprite. The look is a boombox carried by the handle
  in the avatar's right hand (viewer's left, opposite the drink, sketch "D"), plus a first-person view at
  the bottom-right, clear of the self-view. Rejected: uploading to the server with synced playback, and
  DataChannel file transfer (sync, late joiners, storage). Spec:
  [2026-10-09-boombox-design.md](superpowers/specs/2026-10-09-boombox-design.md). *Amended 2026-10-09:* while
  playing, the audio panel (`` ` ``) shows a Boombox column right of the tuning settings with the track name, a
  seekable progress bar, volume and Stop; starting the music doesn't open the panel; the volume is remembered per browser
  (`zoom3d.boombox.volume`). The volume is a gain before the split, so it turns down both the carrier's own monitor and what the
  room hears, with no protocol message (spec §3.1).

### D17 — Lobby (pre-join screen)
- What the join screen offers for camera, mic, name and picture, and what "camera off" means.
- *Resolved 2026-10-09:* a minimal lobby: a 176 px disc showing the live framed camera (or, with the camera
  off, the picture or initials plus a pencil for Choose picture… / Remove), a mic-level ring around it,
  camera and mic split buttons (icon toggles, chevron picks the device), the name, Join. Camera and mic start
  when the invite link opens, each requested separately with the saved `deviceId`; a camera saved as off is
  never opened. Camera off **stops** the camera (light out) in the lobby and in the room; mic off only mutes.
  To turn the camera back on in the room without renegotiating, the framer's canvas track is always sent and
  the framer gets a swappable camera source. Devices and on/off states are remembered in `zoom3d.media`.
  Rejected: a 16:9 Zoom-style preview (avatars are discs), a separate mic meter bar and labelled fields (too
  busy), a pencil shown with the camera on (it changes nothing visible). Out of scope: speaker choice,
  switching devices in the room. Spec: [2026-10-09-lobby-design.md](superpowers/specs/2026-10-09-lobby-design.md). *Amended 2026-10-09:* saved and chosen devices are requested with `deviceId: { exact }` and retried with no `deviceId` only when the device is gone; Chrome ignored the `ideal` form and always gave the default device (spec §3.1). *Amended 2026-10-09:* the mic level is shown inside the lobby's mic icon (its capsule fills green) instead of as a ring around the disc, which blinked around the face. The room bar has no meter.

### D18 — Join sound
- Whether and how the room tells you someone arrived.
- *Resolved 2026-10-09:* a doorbell: a synthesised two-tone chime (E5 then C5, each a struck bar with a
  fast-dying ×2.76 overtone), rung for whoever arrives: on `peer_joined`, and for the newcomer on their own `welcome`
  when it is a fresh slot. Not for people already in the room when you join, and not for a reconnect that resumes
  its slot. It plays straight to `ctx.destination`
  at a fixed low volume, not through the spatial graph: it's the room's bell, not a sound from a place. Arrivals
  less than 2 s apart ring once. No asset file and no protocol change (`apps/web/src/audio/doorbell.ts`).

### D19 — Landing page
- What `/` shows before anyone has a room.
- *Resolved 2026-10-09:* a title picture in the spirit of a Wolfenstein 3-D title screen, but nothing copied from it:
  one still frame from our own renderer (`apps/web/src/ui/landing-scene.ts`). Max sneaks a beer in a niche behind a
  corner while Ada and Bob talk down the blue-stone corridor. They are real avatars with 16×16 pixel-art faces
  scaled into the face texture, and no name labels. Tests pin the staging: every disc is whole from the camera, and
  Max is out of Ada's and Bob's line of sight. "zoom3d" is pixel lettering drawn into the same frame in the top-right
  corner (`landing-logo.ts`): blocky glyphs, chrome fading into red, black outline and drop shadow. The frame is
  drawn once; the room loop never starts on `/`. A lobby-style panel (tagline, blue "Start a party"; the heading is
  for screen readers only) sits in the bottom-right corner below it, undimmed; both are inset
  28 of 640 px from their corner. *Amended 2026-10-10:* the lobby shows the same picture without the logo, dimmed, behind its
  centred panel; the room loop starts on Join instead of running behind the lobby.

### D20 — Logs, metrics, error reporting, analytics
- *Resolved 2026-10-10:*
  - **Server logs:** one JSON object per line on stdout (`apps/server/src/log.ts`), level from `LOG_LEVEL` (default
    `info`). Hand-rolled, no logger library. Lobby events carry room and peer ids only: never names, resume tokens or
    IPs.
  - **Server metrics:** Prometheus text at `GET /metrics` on the server port (`metrics.ts`), using
    `@prometheus-io/client` (`prom-client` is deprecated in its favour): rooms, peers (connected / waiting), joins by
    result, messages by type, drops by reason, server-cut connections, plus Node process metrics. Not public: Traefik
    and the web nginx route only `/ws` to the server. casa's Prometheus is currently disabled, so nothing scrapes it yet.
  - **Sentry, both sides, errors only:** no tracing, no session replay (the screen shows names and faces). The server
    turns on when `SENTRY_DSN` is set at runtime and reads `SENTRY_RELEASE`, which CI bakes into the image. The web DSN
    is a build arg. Projects `zoom3d-server` and `zoom3d-web` are in the `myownradio` org. The browser `beforeSend`
    scrubs `/r/<roomId>` from the whole event: a room link is the room's only key. Sentry v11 is bundled with
    `enableRuntimeChannelInjection: false`, since a bundle can't load its instrumentation hooks.
  - **Amplitude, web only, anonymous, no consent banner:** project `zoom3d`. `identityStorage: 'none'` (a new device
    id each visit), no IP, no autocapture, remote config off, so Amplitude's UI can't turn autocapture back on.
    Events: sessions (`room_joined`, `room_left` with duration, largest room and drops), social (`drink_picked`, `sip`,
    `cheers`, `boombox_started`) and connection health (`connection_lost/restored/failed`, `webrtc_failed`,
    `face_detector_unavailable`). There are no media-toggle events. The full list is the `AnalyticsEvent` type in
    `apps/web/src/telemetry/analytics.ts`.
  - **Config:** the web DSN, the Amplitude key and the release are Vite build args passed by
    `.github/workflows/docker.yml`. Both values are public by design, since browsers see them anyway. Unset (dev,
    tests, forks), everything stays off. Both SDKs are lazy chunks, so the main bundle stays the same size.

### Risks (to verify, not assume)
- **R1 — Echo cancellation vs Web Audio output.** Chrome's AEC historically did not cancel audio played via `AudioContext`. If still true, speakers echo. Verify in an early throwaway audio spike (speakers vs headphones).
  - *Verdict 2026-10-08 (provisional):* user tested Chrome on both devices with the spike and reported it "sounds good", i.e. no echo problem heard. Interpreted as outcome (a): M4 uses the `webaudio` path (graph → `AudioContext.destination`). The per-mode table was not filled in and **Firefox is untested**, so re-check Firefox (and speakers at higher volume) in M5 before relying on (a) there.
  - *2026-10-08 (M4):* implemented per (a): voices play only through the Web Audio graph to `ctx.destination`. Firefox and speaker echo still to be verified in M5.
- **R2 — Background tabs.** rAF stops in hidden tabs; nothing peers depend on may be driven by the render loop.
- **R3 — Safari** WebRTC/Web Audio quirks; best-effort support.

## Resolved
_(none yet)_
