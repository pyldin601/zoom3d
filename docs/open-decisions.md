# Decision log

Format: **ID — question** · options · recommendation. Move to *Resolved* with date + rationale.

## Open

### D1 — Media topology
- **Mesh (P2P)**: no media server, simplest, cheapest. Upload cost grows with N-1 streams; fine to ~6–8 when faces are tiny (≤160 px, ~15 fps).
- **SFU** (LiveKit / mediasoup): scales to dozens, simulcast, server-side bandwidth control. More infra.
- **Rec:** start with mesh behind a thin `MediaTransport` interface; swap to LiveKit if we outgrow it.
- *Partially resolved 2026-10-08:* target group size is 2–8 participants for v1, so mesh is viable. Final call pending design approval.
- *Resolved 2026-10-08 (M3):* mesh implemented behind `MediaTransport` (`apps/web/src/media/mesh.ts`). Single initiator (greater id offers), perfect negotiation for renegotiation, 150 kbps video cap.
- *Resolved 2026-10-11 (SFU):* media goes through a self-hosted **LiveKit** SFU on casa; the mesh is removed. Rooms of 100+
  people (the new target) need every participant to upload once and the server to choose what each one receives, which a
  mesh can't do. LiveKit over mediasoup: built-in TURN, simulcast and selective subscription, with a maintained client
  SDK, so the client stays a thin `MediaTransport` (`media/livekit.ts`). Spec: `docs/superpowers/specs/2026-10-11-livekit-sfu-design.md`.

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
- *Resolved 2026-10-10:* pnpm 12. It fails the install (`ERR_PNPM_IGNORED_BUILDS`) when a dependency's build script is not reviewed, so `pnpm-workspace.yaml` lists the allowed ones under `allowBuilds` (only `esbuild`). A new dependency with a build script must be added there as `true` or `false`. pnpm also rejects packages published less than a day ago (`minimumReleaseAge`, `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`), so `renovate.json` sets `minimumReleaseAge: "1 day"` to hold updates back for the same window.

### D11 — Hosting / deployment
- Needs HTTPS (getUserMedia) and likely TURN (coturn or a hosted one). Where will it run?
- *Resolved 2026-10-09 (restarts only):* rooms survive a server restart. The server runs as one replica with the
  k8s `Recreate` strategy. On SIGTERM it writes the lobby to `STATE_FILE` on a persistent volume, and the next
  process reads the file at start-up and deletes it. Every restored slot gets a fresh grace period, so clients
  resume with the same id and keep their P2P mesh. We rejected Redis plus a per-room lease (which rolling deploys
  need, to avoid two pods serving one room) as too much machinery. With `Recreate`, the restart gap is covered by
  the 30 s grace period, and media between peers never stops. Long-term persistence stays out of scope.
- *Resolved 2026-10-11 (TURN):* no TURN server of our own for now. The next step is a LiveKit SFU on casa, which has
  its own TURN (UDP 3478 and TLS on 443), so the server hands out Google STUN only until then. A coturn deployment
  on casa was tried and removed the same day. Lessons for LiveKit's TURN on this node:
  - Traefik owns 443, so TURN/TLS needs an SNI `IngressRouteTCP` that routes `turn.` to it.
  - The home IP is dynamic, so the advertised public IP has to follow it.
  - coturn's `external-ip=public/private` form allow-lists the node IP as a relay peer, ahead of
    `denied-peer-ip`. Anyone who joins a room could then send UDP to the node, flannel VXLAN included.
  - A TURN server behind the home NAT can't relay to clients on the home LAN, since they share its public IP.
  - In an SFU, clients reach the server rather than each other, so relay-to-relay doesn't come up.
- *Resolved 2026-10-11 (LiveKit on casa):* LiveKit v1.13 runs in the `zoom3d` namespace (servers repo
  `k8s/casa/apps/zoom3d/livekit.yaml`), host network, `wss://lk.pyldin601.xyz`. Media uses UDP 49160-49163 and ICE/TCP
  7881, TURN uses UDP 3478 and TLS on 443 through Traefik. TURN relays to the SFU through the public IP, so it needs
  the router to hairpin UDP: it didn't at first (TURN-only clients failed), and does since the router's ports were
  reconfigured the same day (a relay-only client works). Node: `net.core.rmem_max = 5000000` in
  `/etc/sysctl.d/90-livekit.conf`, for LiveKit's UDP receive buffer.

### D12 — Input and accessibility
- Keyboard only vs mouse-look vs touch. Colour-blind/readable names above avatars? Captions?
- *Partially resolved 2026-10-10 (touch):* phones and tablets get on-screen controls. A faded move pad bottom-left (one
  touch area, 8 directions, dead zone in the middle), drag anywhere on the view to turn (no turn buttons, which would
  cover faces), a drink button (tap to sip, hold to cheers) and a ⋯ tray for drinks, boombox and map. A touchscreen
  laptop shows them after its first touch. Pointer lock is only for mouse pointers. Accessibility questions stay open.
  Spec: [2026-10-10-mobile-design.md](superpowers/specs/2026-10-10-mobile-design.md).

### D13 — Findability
- *Resolved-pending-spec 2026-10-08:* shared spawn near the blue-diamond start + toggleable automap showing walls and named participant dots.

### D14 — Aspect ratio
- *Resolved-pending-spec 2026-10-08:* the UI keeps a stable 16:9 aspect ratio: letterboxed game viewport, fixed FOV, HUD and overlays anchored to the viewport box. Optional integer-scale mode.
- *Amended 2026-10-10:* touch devices (`(pointer: coarse)`, decided once at page load) get a full-window frame shaped
  to the screen instead: the internal buffer's long side is 640 px, and the horizontal FOV goes from 66° at 16:9 and
  wider down to 50° on a tall phone (9:19.5), linear in aspect. Desktop keeps the 16:9 letterbox. We rejected "cover"
  cropping of the 16:9 picture: on an upright phone it keeps only a quarter of the view (~17°). Spec:
  [2026-10-10-mobile-design.md](superpowers/specs/2026-10-10-mobile-design.md).

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
  room hears, with no protocol message (spec §3.1). *Amended 2026-10-10:* the picker offers, and the boombox
  accepts, only formats every current browser decodes (MP3, M4A/AAC, WAV, FLAC), not `audio/*`. WebRTC re-encodes
  whatever the element decodes, so the decoders are the real limit; Ogg, Opus and WebM are left out as patchy in
  Safari, so a track that plays for one carrier plays for any (spec §3).

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
  switching devices in the room. Spec: [2026-10-09-lobby-design.md](superpowers/specs/2026-10-09-lobby-design.md). *Amended 2026-10-09:* saved and chosen devices are requested with `deviceId: { exact }` and retried with no `deviceId` only when the device is gone; Chrome ignored the `ideal` form and always gave the default device (spec §3.1). *Amended 2026-10-09:* the mic level is shown inside the lobby's mic icon (its capsule fills green) instead of as a ring around the disc, which blinked around the face. The room bar has no meter. *Amended 2026-10-11:* in the room the mic and camera toggles left the top bar for the bottom-right corner, next to the face they control: clicking your own circle (the self-view) turns the camera off and on (a dark red border while off, and on hover an icon of what a click will do), and a round mic button with the lobby's mic icon sits to its left (red with a slash while muted). M and C press them. Rejected: an "M" letter (the icon matches the lobby), a small badge on the circle's rim (at the 44 px touch minimum it would cover the face and crowd the drink and ⋯ buttons). Your own boombox moved left to stay clear of the button (right edge at 84% of the width, was 88%). *Amended 2026-10-11:* the invite link left the room for the lobby: a full-width "Copy invite link" button under Join, after a thin divider ("Copied" for 2 s; a refused clipboard points to the address bar). The room has no top bar any more, so nothing covers the view, and the link is shared before joining, when a host sends it. In the room only the address bar has it. Rejected: an icon button beside Join (easy to miss, and on a phone easy to tap Join instead) and a link strip under the panel (puts the room link on screen shares). The lobby's error line moved out of the panel to just under it, shown only while there is an error: its reserved height left a gap above the invite divider.

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
    `info`). Hand-rolled, no logger library. Lobby events carry peer ids and `room`, a 10-character sha256 prefix
    of the room id (`roomRef`). That is enough to follow one room through the logs, but useless for joining it. Never
    names, resume tokens, IPs or client close reasons.
  - **Server metrics:** Prometheus text at `GET /metrics` on the server port (`metrics.ts`), using
    `@prometheus-io/client` (`prom-client` is deprecated in its favour): rooms, peers (connected / waiting), joins by
    result, messages received by type, messages and bytes sent by type (`zoom3d_messages_sent_total`, `zoom3d_bytes_sent_total`; a broadcast counts once per recipient), drops by reason, server-cut connections, plus Node process metrics. Not public: Traefik
    and the web nginx route only `/ws` to the server. Since 2026-10-11 casa's Prometheus (namespace `monitoring`)
    scrapes it and LiveKit (`:6789`) through pod annotations, plus the node; Grafana at `grafana.pyldin601.xyz` (login
    required) has a provisioned `zoom3d` dashboard: rooms and people, joins and messages, LiveKit rooms, participants,
    tracks, quality, bandwidth and loss, node CPU, uplink and disk. Dashboards only, no alerts (user's choice).
  - **Sentry, both sides, errors only:** no tracing, no session replay (the screen shows names and faces). The server
    turns on when `SENTRY_DSN` is set at runtime and reads `SENTRY_RELEASE`, which CI bakes into the image. The web DSN
    is a build arg. Projects `zoom3d-server` and `zoom3d-web` are in the `myownradio` org. The browser `beforeSend`
    scrubs `/r/<roomId>` from the whole event: a room link is the room's only key. Sentry v11 is bundled with
    `enableRuntimeChannelInjection: false`, since a bundle can't load its instrumentation hooks.
  - **Amplitude, web only, anonymous, no consent banner:** project `zoom3d`. No IP, no autocapture, remote config off,
    so Amplitude's UI can't turn autocapture back on. Events: onboarding (`landing_viewed`, `party_started`,
    `lobby_viewed` as host or invitee, `media_permission`, and `peer_met` as the activation step), sessions
    (`room_joined`, `room_left` with duration, largest room and drops), social (`drink_picked`, `sip`, `cheers`,
    `boombox_started`) and connection health (`connection_lost/restored/failed`, `webrtc_failed`,
    `face_detector_unavailable`). There are no camera/mic toggle events. The full list is the `AnalyticsEvent` type
    in `apps/web/src/telemetry/analytics.ts`.
    *Amended 2026-10-10:* storage-free, so no consent banner is needed. ePrivacy Art. 5(3) requires consent for any
    storage access that isn't strictly necessary, and that covers sessionStorage and the SDK's default localStorage
    queue of unsent events as much as cookies. The device id (`identityStorage: 'none'`) and the event queue (an
    in-memory `storageProvider`) therefore live in memory, so one page load is one user. To keep the onboarding funnel
    in one load, "Start a party" switches to the lobby in-page with `history.pushState` instead of a page load, and Back
    or Forward reloads the page. The host/invite flag is a variable. `/privacy.html` (linked from the landing panel)
    covers GDPR transparency, with legitimate interest as the basis. Retention and returning-user cohorts would need a
    persistent id behind an opt-in banner.
  - **Config:** the web DSN, the Amplitude key and the release are Vite build args passed by
    `.github/workflows/docker.yml`. Both values are public by design, since browsers see them anyway. Unset (dev,
    tests, forks), everything stays off. Both SDKs are lazy chunks, so the main bundle stays the same size.

### D21 — Rooms of 100+ people
- **Goal (2026-10-11):** one room holding 100+ people. Media already scales on the sender side: since 6b everyone uploads
  once to LiveKit (~0.4 Mbps), whatever the room size. What still grows with N × (N − 1):
  - **Media received:** every client gets everyone's face and voice at full quality (`autoSubscribe`, one 256² layer):
    ~0.4 Mbps × (N − 1) per client, ~4 Gbps out of LiveKit for a full room of 100.
  - **Game state:** the server relays every accepted move as its own `peer_state` (absolute pose + seq, JSON over the
    WebSocket, no batching) to every other peer. Clients send up to 15 Hz while moving. That is ~840 messages/s for 8
    people and ~150,000/s for 100.
  - **Join:** `welcome` lists every peer with its avatar picture (≤ 12 KB each): ~1.2 MB for 100.
- **Planned, in order (roadmap M7):**
  - **6c, dynamic subscription (receive only what you can see or hear) — built 2026-10-11** ([spec](superpowers/specs/2026-10-11-dynamic-subscription-design.md)):
    `autoSubscribe` off; every 250 ms the client decides per peer what to receive, and subscribes per publication
    (`setSubscribed`).
    - **Facts come from the UI, decisions from one rule.** The renderer's sprite pass writes, per peer, the disc
      columns seen (in front of the walls and not behind a nearer disc, so a crowd's back rows get no video) and the
      disc's size in pixels (reused objects, no allocations);
      `media/interest.ts` (pure, unit-tested) turns them, positions and the audio range into wants.
    - **Why not raw "drawn this frame":** a resumed video needs ~0.3–1 s for a keyframe, so the rule adds:
      - **Video:** wanted when seen, or as look-ahead just outside the view (within 20 tiles, 15° beyond each edge, in
        line of sight). Upgrades at once; downgrades and stops only after 1 s. A face out of view keeps its last frame (and
        holds it while resuming), never flashing to initials.
      - **Audio:** voices are silent beyond the audio setting `max` (24 tiles by default). Subscribed within `max + 2`,
        dropped beyond `max + 4`; the boombox follows the mic.
      - **Caps:** at most 12 videos and 24 voices, nearest first, among peers that publish media (bots never take a
        slot). A hidden tab receives no video at all, at once; audio is unchanged.
    - **Three sizes as separate tracks, not simulcast.** The 6c spike (Chrome, LiveKit 1.13.9) found
      `livekit-client` turns simulcast off below 480 px, and Chrome won't split a 256² source into VP9 SVC layers. So
      the framer draws three canvases, each published as its own track; the receiver picks by on-screen size (≥ 128 px
      → 256, ≥ 48 px → 128, else 64; kept until 20% below the threshold):

      | Track | Size | Frame rate | Bitrate cap |
      |---|---|---|---|
      | `face` | 256×256 | 24 fps | 350 kbps (as 6b) |
      | `face-128` | 128×128 | 24 fps | 120 kbps |
      | `face-64` | 64×64 | 15 fps | 35 kbps |

      - **Sender upload:** **dynacast** is on again: LiveKit pauses any face track nobody receives (spike: 0 kbps,
        resumed on subscribe), so a sender uploads only the sizes someone wants. A new track sends for its first ~10 s
        before LiveKit pauses it; alone in a room, only the mic is uploaded after that.
      - **Hidden tab:** all three carry the raw camera; `face-128`/`face-64` scale it with `scaleResolutionDownBy`.
      - **Receiver:** e.g. 3 close + 5 mid + 4 far faces ≈ 1.8 Mbps of video, against ~4.2 Mbps for the same 12 at
        full quality in 6b (plus everyone out of view).
      - **Mixed versions:** an old client publishes only `face`; new clients fall back to the nearest published size.
    - The SFU then forwards only what each client asked for, so a full room's egress scales with what people can
      see and hear, not with N × (N − 1). To measure on casa: LiveKit egress on the dashboard before/after.
  - **6d, server fan-out — built 2026-10-11** ([spec](superpowers/specs/2026-10-11-server-fan-out-design.md)):
    per-move `peer_state` relays are gone. Every 66 ms the server steps bots and robots, then sends each person **one
    `peers` batch** of the poses that changed: peers within 16 tiles every tick, farther ones at most every 500 ms.
    - **Wire:** entries are `[slot, x, y, angle]`, rounded to 0.01 tile and 0.001 rad. Slots are small per-room
      numbers that are never reused. Absolute poses (no deltas): a lost batch costs one stale frame, never a corrupt
      state.
    - **Client:** each peer is drawn 100 ms late when near and 750 ms when far, changing at most 0.5 ms per ms. After a
      pause it is held at its last pose, so it never starts mid-way.
    - **Avatars:** pictures leave `welcome` for `GET /avatar/<id>`. The id is a content hash, ref-counted across
      rooms and cached forever; the snapshot still keeps data URLs (version 1).
    - **Rooms of 100+:** `MAX_PEERS` is 128. People after the eighth get golden-angle colours. Labels and automap
      names show only within 10 tiles.
    - **Old tabs:** `join.v = 2`. A join without it gets `invalid_room` (old tabs show "Couldn't join this room");
      an older `v` gets the new fatal `outdated` ("zoom3d was updated: reload the page").
  - **Testing aid (2026-10-11): bots.** `/?bots=N` (1–100) → "Start a party" makes a room whose creating join asks the
    server for N bots: generic names ("Bot 001"), muted colours, no media, spawned on random floor tiles, wandering like
    robot vacuums (straight on, a random new heading at a wall, now and then a turn) at 10 Hz through the normal
    `peer_state` relay (since 6d: every fan-out tick, in the same `peers` batches as people). Outside the people cap; gone when the last person leaves; at most 3 bot rooms per server.
    100 bots on desktop Chrome: 60 fps, with ~1,000 position messages/s per client, which is what 6c/6d are measured
    against.
  - **Then a load test:** `lk load-test` for 100 simulated media participants plus a bot swarm on the game socket,
    measuring LiveKit CPU and egress on casa (4 cores, 1 Gbps), server CPU, and browser frame rate. casa's limits
    (shared 4 cores, UDP buffer `net.core.rmem_max`) are the main risks; monitoring (LiveKit Prometheus + Grafana)
    comes first.
    - **Run 2026-10-12** ([report](load-tests/2026-10-12-m7-100-people.md)): **100 people fit.** Results:
      - **Game socket:** 100 walking clients cost the server 0.35 cores, 30 msg/s per client, no corrections.
      - **Media:** LiveKit fed 100 subscribers at the 6c caps with 0% loss.
      - **Both at once:** node CPU ~60%.
      - **Browser:** 60 fps in the crowd.
    - **Full model, scaled:** ~75–85% node CPU and ~265 Mbit/s LiveKit egress.
    - **Untested:** casa's internet uplink and ingest from 100 real publishers. Measure the uplink before a
      100-person event.
- **Decided (product, 2026-10-11): proximity only.** You see and hear people near you; clusters are natural breakout
  rooms. No room-wide stage/spotlight or webinar mode in M7 (a stage would need a broadcast path on top of 6c's
  rules).

### Risks (to verify, not assume)
- **R1 — Echo cancellation vs Web Audio output.** Chrome's AEC historically did not cancel audio played via `AudioContext`. If still true, speakers echo. Verify in an early throwaway audio spike (speakers vs headphones).
  - *Verdict 2026-10-08 (provisional):* user tested Chrome on both devices with the spike and reported it "sounds good", i.e. no echo problem heard. Interpreted as outcome (a): M4 uses the `webaudio` path (graph → `AudioContext.destination`). The per-mode table was not filled in and **Firefox is untested**, so re-check Firefox (and speakers at higher volume) in M5 before relying on (a) there.
  - *2026-10-08 (M4):* implemented per (a): voices play only through the Web Audio graph to `ctx.destination`. Firefox and speaker echo still to be verified in M5.
- **R2 — Background tabs.** rAF stops in hidden tabs; nothing peers depend on may be driven by the render loop.
- **R3 — Safari** WebRTC/Web Audio quirks; best-effort support.

### D22 — Voxel objects and the robot vacuum
- *Resolved 2026-10-11* ([spec](superpowers/specs/2026-10-11-robot-vacuum-design.md)): zoom3d gets **world objects**,
  starting with a robot vacuum in every room. It cleans the floor in 3×3-tile patches (the edge first, then lanes) at a
  real robot's pace, about 1.5 h for LEVEL1, then searches for its dock forever and never finds it.
  - **World objects are not peers.** The server simulates them per room (`apps/server/src/objects/vacuum/`, stepped with
    the bots, every fan-out tick since 6d) and relays `object_state`. They have no labels, automap dot, media or `MAX_PEERS` slot, and
    never keep a room open. The robot is saved in the state file with a map fingerprint; a different map gives a
    fresh robot.
  - **Models are described in code** (`renderer/models/`), not imported from an editor. `renderer/voxels.ts` draws
    their exposed faces as flat-shaded quads, far to near among the discs and depth-tested against the walls. The
    look is variant C, "chunky retro toy", picked in the brainstorm.
  - **It bumps into people, not bots,** then steps aside and drives round them. A 100-bot room would otherwise jam it.
    People walk through it.
  - **Its hum is synthesised** (variant B, "soft purr", picked by ear) and goes through the voice path
    (`AudioEngine.attachNode`). It is always quieter than a voice at the same distance (`VACUUM_GAIN`).
  - **Pace:** it drives at 0.6 tiles/s and turns at 90°/s. Lanes are 0.6 tiles apart, which brought the full clean
    inside the 50 min – 2 h target.

### D23 — Smooth peers within batched fan-out
- **Question (2026-10-13):** after 6d, nearby people visibly hitch while walking. Go back to relaying each move at once
  (with a slower rate for distant people), or keep the batches?
- *Resolved 2026-10-13:* **keep the batches**, and place every pose on its real timeline.
  - In a meeting room nearly everyone is within 16 tiles, so per-move relays would bring back ~N² messages
    (~150,000/s for 100 people), the cost 6d removed.
  - The hitch came from the client's and the server's 66 ms timers drifting against each other, not from batching.
    Each `peers` entry now carries `age`, the ms since the server accepted the pose. The client stamps it
    `arrival − age`, draws near peers and objects 150 ms late (was 100), and treats only a gap longer than the
    interval plus two ticks as a pause. `PROTOCOL_VERSION` goes to 3. Details and the simulation's numbers: 6d spec
    §2.2–2.3.

### D24 — Lighting
- *Resolved 2026-10-13* (spike, shipped as is): static ceiling lamps baked into lightmaps when the map loads
  (`renderer/lighting.ts`, about 57 ms for LEVEL1). Shadows are hard and grid-exact: a 2D line of sight from each
  lamp to each wall, floor and ceiling sample. Per frame, a wall pixel costs one lookup and a multiply, and floor and
  ceiling (now cast per pixel, row by row) one lookup each: +0.24 ms over 0.58 ms at 640×360.
  - **Ambient drops to 45%.** North/south faces stay at 70%, but only of the ambient part.
  - **Lamps light the corridors:** auto-placed on every floor run at most 3 tiles across and at least 4 long, at least
    5 tiles apart (37 on LEVEL1). The landing scene has two hand-placed lamps.
  - `?lights=off` shows the old flat look.
  - **Voxel objects are lit too** (2026-10-13), per frame: the lamps in reach and in sight of the object's centre
    light each of its five face directions. The old flat shading only scales the ambient part.
  - **Voxels can glow** (`glow(colour, L)` in a model, L 0..1): the face is blended towards its own colour, untouched
    by ambient, lamps, shadows and flat shading; at 1 it's always full colour. Glow lights nothing around it. The
    vacuum's eyes and the disc on top glow fully.
  - **Brick relief, lit by the lamps** (2026-10-13): stone and blue-stone bricks catch lamp light on their top row,
    darken on their bottom row and shade the mortar under them (`RELIEF` in `renderer/textures.ts`, lit from above
    like the ceiling lamps). Only lamp light is scaled, so relief fades away between lamps. The bake stores each wall
    sample's light per relief level, and the wall loop shades each texel once and repeats it down its rows: +0.04 ms.
    Wood is flat.
  - Not done yet: avatars aren't lit, shadow edges are stair-stepped, rooms get no lamps of their own.

## Resolved
_(none yet)_
