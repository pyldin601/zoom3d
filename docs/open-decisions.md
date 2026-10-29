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
- *Resolved 2026-10-09:* distance curve is physical. Dry follows 1/d (−6 dB per doubling) and the reverb send is 0.4/√d (−3 dB per doubling). Both fade to silence over the last quarter of `max`, and `max` goes from 12 to 24 tiles. Why: the old quadratic curve had almost no reverb up close (a near voice sounded "in my room"), and it dropped the reverb together with the voice, so silence came too soon. Spec §9.2. The storage key was bumped to `zoom3d.audio.v2` so the old saved `max: 12` doesn't hide the new default. *Amended 2026-10-16:* the live audio tuning is gone from the backtick panel (`` ` ``), sliders, Output (Headphones/Speakers), Reset and the speaking levels list alike. Everyone hears `DEFAULT_AUDIO_SETTINGS` (HRTF panning), and the browser no longer reads the saved `zoom3d.audio.v2`: with no panel, a saved value could never be changed or reset. The panel now holds only the frame rate at the top, the renderer's Lighting mode under it, and the boombox column while your boombox plays (it keeps the `audio-panel` name for that column). Opening it releases mouse-look (pointer lock) so the mouse can work it; a click on the view locks it again.

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
- *Resolved 2026-10-17:* the code explains itself (docs/code-style.md). Names, types and top-down named stages say
  what code does; a comment stays only for why (a constraint, a measurement, a decision, a fact about the maths).
  Doc comments that repeat a name go, which replaces "every exported symbol and constant has a doc comment". Older
  code is improved as it is touched, in readability refactors of their own.

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
  switching devices in the room. Spec: [2026-10-09-lobby-design.md](superpowers/specs/2026-10-09-lobby-design.md). *Amended 2026-10-09:* saved and chosen devices are requested with `deviceId: { exact }` and retried with no `deviceId` only when the device is gone; Chrome ignored the `ideal` form and always gave the default device (spec §3.1). *Amended 2026-10-09:* the mic level is shown inside the lobby's mic icon (its capsule fills green) instead of as a ring around the disc, which blinked around the face. The room bar has no meter. *Amended 2026-10-11:* in the room the mic and camera toggles left the top bar for the bottom-right corner, next to the face they control: clicking your own circle (the self-view) turns the camera off and on (a dark red border while off, and on hover an icon of what a click will do), and a round mic button with the lobby's mic icon sits to its left (red with a slash while muted). M and C press them. Rejected: an "M" letter (the icon matches the lobby), a small badge on the circle's rim (at the 44 px touch minimum it would cover the face and crowd the drink and ⋯ buttons). Your own boombox moved left to stay clear of the button (right edge at 84% of the width, was 88%). *Amended 2026-10-11:* the invite link left the room for the lobby: a full-width "Copy invite link" button under Join, after a thin divider ("Copied" for 2 s; a refused clipboard points to the address bar). The room has no top bar any more, so nothing covers the view, and the link is shared before joining, when a host sends it. In the room only the address bar has it. Rejected: an icon button beside Join (easy to miss, and on a phone easy to tap Join instead) and a link strip under the panel (puts the room link on screen shares). The lobby's error line moved out of the panel to just under it, shown only while there is an error: its reserved height left a gap above the invite divider. *Amended 2026-10-16:* the room shows how many people are in it: a small dark pill in the top-right corner with a two-people icon and the number, you included (1 when alone), and the spelled-out count as its title. It is the one thing always on over the view. Bots count too, because the client can't tell them from people (a `?bots=100` room shows 101). The frame rate is not on screen: it is the "Frame rate" line at the top of the backtick panel, above the renderer's Lighting mode, counted over half-second windows and coloured green from 55 fps, amber from 30, red below. *Amended 2026-10-16:* under it, "Render time" shows how long drawing a frame takes (the glows, walls, sprites, your own items, the canvas and the HUD; not game logic, audio or network) as a share of one screen frame, then in ms, e.g. `30% · 2.5 ms`, green under 50%, amber under 80%, red above. A screen frame is the shortest interval rAF has given since load: its timestamps fall on refreshes, so the shortest is one refresh however slow drawing gets, and drawing slower than the screen reads over 100% instead of as a slower screen. Moved to a slower screen, it reads high until reload. Rejected: both in one top-right pill, or the frame rate in the top-left corner (every player would see a number that only matters while tuning the renderer), and a list of names on clicking the count. *Amended 2026-10-16:* the backtick panel shows which of your face sizes others receive (6c): a "Face sent" row under the frame rate with a dot and the size's number for each, 256, 128 and 64. A dot is green (and its number bright) while someone receives that size, and dim while dynacast has it paused: the transport reads the face track's sender encoding, which LiveKit switches off (in Firefox, turns down to 10 bps) while nobody receives it. It was first drawn on the HUD, as unnumbered dots sized by quality on an arc off the self-view's lower right, and moved to the panel the same day: it is a look under the hood, like the frame rate, and there the numbers say it plainly. Rejected on the HUD: equal dots, and a hollow ring for a paused size.

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
  *Amended 2026-10-13* ([landing vacuum spec](superpowers/specs/2026-10-13-landing-vacuum-design.md)): the picture
  comes alive. The room's robot vacuum, parked out of view, comes out after 10 s, cleans the corridor (bumping Ada,
  Bob, Max and the camera, about 10 min) and then searches for its dock forever. No input reaches it, it makes no sound,
  and every visitor sees the same run. Start a party stops it, and the lobby picture stays still and vacuum-free.
  Under `prefers-reduced-motion` the picture stays still. The landing page redraws on its own small loop; the room
  loop still never starts on `/`.

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
  - *Amended 2026-10-13* ([landing vacuum spec](superpowers/specs/2026-10-13-landing-vacuum-design.md)): the sim moved
    to `packages/shared/src/objects/vacuum/` (with `pick` and `seeded` in `packages/shared/src/random.ts`), so the
    landing page runs the same robot in the browser. The server still steps the room's robot, unchanged.

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
  (`renderer/lighting.ts`, about 57 ms for LEVEL1). Shadows are grid-exact: 2D lines of sight from each lamp to each
  wall, floor and ceiling sample (soft since 2026-10-15, below). Per frame, a wall pixel costs one lookup and a
  multiply, and floor and ceiling (now cast per pixel, row by row) one lookup each: +0.24 ms over 0.58 ms at 640×360.
  - **Baked on the room's first frame** (2026-10-16), not when the page loads: with bounce light and soft shadows the
    LEVEL1 bake is about 105 ms (cold, esbuild bundle), and the landing page, which bakes only its own small scene,
    never needs it. By the first frame the join is already connecting.
  - **Current cost** (2026-10-16, `pnpm bench:walls`: LEVEL1 at 640×360 from 176 poses near lamps, esbuild bundle):
    unlit 0.50 ms; lit with reflections off 0.68 ms; walls reflecting 0.90 ms; walls, floor and ceiling 1.28 ms;
    plus 8 glowing avatars 1.58 ms (glow as the brighter of it and the baked light). The bench prints a hash of the
    bake and of every pixel, for refactors.
  - **Ambient is bounce light** (2026-10-15; it was a flat 45%). The bake gathers, per half-tile cell, the lamps'
    direct light on its floor, ceiling and bordering wall faces times each surface's colour (wall colours are the
    textures' averages), then spreads it through the open floor with 40 rounds of blur, never through walls. A
    sample's ambient is a bare 0.08 plus 3.5× the bounce of the cell in front of it (`Bounce` in
    `renderer/lighting.ts`, constants in `renderer/room-lighting.ts`). Lit corridors stay about as bright as before (~0.43 near lamps);
    light falls off into rooms without lamps, which stay dim but never black; walls tint what they throw back (blue
    brick casts blue). The vacuum takes it too (`ambientAt`); avatars aren't lit. Baked once, nothing per frame; the
    bake grows from ~78 to ~123 ms for LEVEL1. North/south faces stay at 70%, of the ambient part only. The landing
    page keeps a flat 45%. An "Ambient light" console switch was tried and dropped once bounce light looked right.
  - **Lamps light the corridors:** auto-placed on every floor run at most 3 tiles across and at least 4 long, at least
    5 tiles apart (37 on LEVEL1). The landing scene has two hand-placed lamps.
  - `?lights=off` shows the old flat look.
  - **Voxel objects are lit too** (2026-10-13), per frame: the lamps in reach and in sight of the object's centre
    light each of its five face directions. The old flat shading only scales the ambient part.
  - **Voxels can glow** (`glowing(colour, L)` in a model, L 0..1): the face is blended towards its own colour, untouched
    by ambient, lamps, shadows and flat shading; at 1 it's always full colour. Glow lights nothing around it. The
    vacuum's eyes and the disc on top glow fully.
    - *Amended 2026-10-23* (owner): one emission rule for every voxel, the ball's. A glow becomes the face's
      **shine** (its colour × L). Each channel shows the brighter of the face's reflected light and its shine (a max,
      owner's call, so a glow never brightens what is already lit). The shine fades with the luminance of the light on
      the face (`1 − smoothstep(0, 0.6, luma)`): whole in the dark, gone in a bright spot, never tinted by a coloured
      lamp. Flat shading ignores it. The vacuum's eyes and disc are full colour in the dark and
      plain cream and yellow paint under a lamp; the ball's dark patches glow a faint green.
  - **Brick relief, lit by the lamps** (2026-10-13): stone and blue-stone bricks catch lamp light on their top row,
    darken on their bottom row and shade the mortar under them (`RELIEF` in `renderer/textures.ts`, lit from above
    like the ceiling lamps). Only lamp light is scaled, so relief fades away between lamps. The bake stores each wall
    sample's light per relief level, and the wall loop shades each texel once and repeats it down its rows: +0.04 ms.
    Wood is flat.
  - **Walls reflect the lamps** (2026-10-13, reworked 2026-10-15): one reflection, whatever the angle. Face-on it's
    a soft spot where the wall mirrors the lamp; looking along a wall towards a lamp the same reflection stretches
    into a blurry streak towards the light.
    - *Model* (`reflection()` in `renderer/lighting.ts`): Blinn-Phong, (n·h)^shininess, times a boost at shallow
      angles, f0 + (1 − f0)·(1 − (v·h)²), times how brightly the lamp lights the surface, 1 / (1 + (d / 1.5×reach)²),
      times a fade over the whole path, lamp to surface to eye, to nothing at 32 tiles. The lamp term was a falloff
      cut off at 1.5× the lamp's reach, which hid lamps seen across a dark room (2026-10-15): a lamp through a
      doorway 12 tiles off left no streak on the floor between. Now it does (+24/255), at the cost of streaks
      growing towards their lamp a little less steeply. Past a lamp's light reach, walls and floor list it by a
      coarse half-tile sight table (`bakeLampSight`, lamps within 16 tiles) instead of an exact sight line each, so a
      far lamp's reflection has half-tile shadow edges. *Amended 2026-10-16:* walls now use the exact share
      (`seenShare`) for far lamps too; only the floor keeps the coarse table. A far lamp shining through a doorway is
      shaded by the door's edge over several tiles, and the yes-or-no table ended its reflection on a wall at a hard line,
      a tile edge in the wood room (seen in the reflections-only view). The LEVEL1 bake is unchanged (112 ms bundled). Schlick's (1 − v·h)⁵ only rises past 80°, and a corridor's
      reflections sit at 60–70°. It replaced two separate effects (a mirror glint and a streak), which competed and
      left a dark gap beside each lamp, like a shadow.
    - *Materials* (`REFLECTION_MATERIAL` in `renderer/textures.ts`): varnished wood is glossy (shininess 16, f0 0.4),
      a soft spot face-on and a narrower streak; brick is rough (8, 0.05), barely there face-on and a long streak.
      Mortar stays matte (`GLOSS`). Light stone is near white under a lamp, so it reads as matte, which suits it.
      The ceiling doesn't reflect the lamps; it mirrors the floor (below).
    - *Floor* (2026-10-15): the same model on a semi-glossy floor facing up (shininess 16, f0 0.1, `FLOOR_MATERIAL` in
      `renderer/walls.ts`): each lamp ahead leaves a narrow smear on the floor, faint near the eye, strongest part way
      and gone under the lamp. It's worked out every 16 pixels on every other row and blended between (every 8 on
      every row cost +0.21 ms); about +0.11 ms. Shadows: the floor's light bake also lists up to 3 lamps each floor
      cell can see (`floorLamp`, the same cells and sight lines), and each pixel adds a reflection only if its own
      cell lists the lamp. Blending alone carried reflection up to 16 pixels into shadows, in 2-row steps: a comb
      interleaving with the shadow edge (fixed 2026-10-15). With 8 slots per cell (below) the lists take 1.9 MB for
      LEVEL1, lamp indices as signed bytes (2026-10-16; so at most 127 lamps, which the bake checks), plus 1.9 MB for
      how much of each lamp a cell sees.
    - *Ceiling* (2026-10-15): it catches the lamps' light off the floor, not the lamps and not the floor: each lamp
      mirrored in the floor (as far under it as the lamp is over it) reflected in the ceiling with the floor's model
      and material, at half strength (`CEILING_SHINE` in `renderer/walls.ts`), each cell's shadows as the floor's.
      Mirrored over the eye's height that's the floor's own reflection of a lamp 1 + z high, so it's the same code.
      Tried and dropped: a ceiling lit by the lamps; one mirroring the floor's colours (texture and all), then its
      reflections, at 3d along the ray, which showed the floor plan, walls and doorways and all, like a mirror. Avatar
      glow doesn't show in it. About +0.25 ms.
    - *Colour* (`reflectedColour()` in `renderer/colour.ts`): plain RGB addition of the warm lamp turned blue brick
      violet, a hue in neither. The lamp's light is now mixed in OKLab, where warm on blue passes through grey, never
      violet: as bright as addition, its colour axes weighted by brightness. That alone keeps the lamp's brightness,
      which on dark saturated blue (blue weighs little in brightness) is mostly red and green, a white wash. So brick
      reflects 85% more of its own colour (`tint`) and 15% that light; wood reflects the light, and stays warm. It's
      worked out once per texture and lamp, from the texture's average shiny texel, so a texel costs three
      multiplies.
    - *Which lamp:* the bake lists, per wall sample column and per floor cell, the 2 nearest lamps in sight in each
      direction, east, west, south and north (`wallLamp`, `floorLamp`, `REFLECTION_LAMPS`, 8 slots), and each screen
      column or floor sample takes the one that reflects brightest (since 2026-10-16 a wall column per height, see
      *Soft shadows*). Each simpler list made a
      reflection stop dead at a line: one baked lamp per column never picked the lamp you look towards; the 3 nearest
      let a lamp behind the eye push out the one ahead; 1 per direction let a corridor's nearer lamp push out the next
      in the row (the far lamp's floor streak vanished under the near one).
    - *Only near the wall:* it fades out as the eye steps away from the wall (gone at 4 tiles, `REFLECTION_NEAR`)
      and with distance (gone at 8, `REFLECTION_RANGE`). "Away from the wall" is from the wall itself, not its endless
      plane (`distanceToWall`): the bake records each face's run, the unbroken line of faces on that side
      (`faceRun`), and past a run's end the distance counts to that end. Measured to the plane, a far wall face lying
      in line with the eye (a pillar's side down the corridor) counted as close and flashed a stripe down its edge.
      A wall that resumes in the same line after a doorway is a separate run, so its streak starts dimmer.
    - *Console* (backquote, under the audio tuning): "Reflections" picks None, Walls, or Walls, floor and ceiling (the
      default), kept per browser (`ui/render-settings.ts`, like the audio settings). The landing page always shows
      both.
    - *Amended 2026-10-16:* the console's "Reflections" choice became "Lighting", a mode for the whole renderer:
      No shadows (classic: the unlit renderer, as with `?lights=off`, avatars and objects unlit too), Shadows (lit, no
      reflections), Shadows and reflections (the default: walls, floor and ceiling) and Reflections only. The last is
      a view for judging the reflections: walls, floor and ceiling show the lamps' reflections alone on black, with no
      baked light or avatar glow (`ReflectionMode` `'only'`); avatars, objects and your own drink are drawn as in the
      lit modes, so you can still see who is where. Walls-only reflections left the menu; the renderer and
      `pnpm bench:walls` keep them. A choice saved as "Reflections" falls back to the default.
    - *Per frame:* a wall column whose reflection peaks under half a step of brightness is skipped; the rest work it
      out at 17 heights and blend them per texel row (per texel row it cost +1 ms). Floor and ceiling are drawn first,
      then each row's reflection is added in its own pass, which skips the 16-pixel spans whose samples both show
      nothing (2026-10-16; adding it inside the floor loop cost about 0.2 ms more in every lit mode, reflections off
      too). Walls add about +0.22 ms, floor and ceiling +0.38 ms (see *Current cost*).
  - **Avatars glow** (2026-10-15): faces stay at full brightness, like screens, and each one lights the floor,
    ceiling and walls around it with its face's average colour (sampled 16×16; ring colour without a face), up to
    2.5 tiles (`renderer/glow.ts`; at 1.5 a person in the middle of a 3-wide corridor lit no wall). Your own face
    glows around you too: the framer's canvas scaled to 16×16 and averaged every 250 ms (`media/own-glow.ts`), or
    your ring colour with the camera off. Glows add up with each other, but a surface takes the brighter of their sum
    and its baked light, per channel, not the two added (2026-10-16): added, a face lit a lamp-lit corridor as
    brightly as a dark room, and looked like it shone. Now it shows in the dark and is lost under a lamp, like a
    screen's light. Per frame: the floor and ceiling get it per floor cell, added into copies of
    the baked colours around each avatar and put back next frame, so it costs the cells near avatars, not the pixels
    showing them; walls per column, at 9 heights. About +0.06 ms for 7 avatars, +0.16 ms for 20. The camera colour
    costs ~0.2 µs per avatar per frame over the ring colour: kept for the screen-light look. No shadows: across a
    one-tile wall it can reach a strip at the far side's foot. Tried and measured first: faces lit by the room
    (ambient, bounce and lamps on the side facing the eye, floored at 35%; +0.01 ms); the glow evaluated per pixel
    (+0.8–2.1 ms), then per 8 pixels (+0.7–1.4 ms).
  - **Soft shadows** (2026-10-15): a lamp casts shadows as a disc the size of its fixture (`LAMP_RADIUS`, 0.18 tiles),
    so a wall's edge hides part of it and shadows fade in over a few cells instead of stepping (`seenShare` in
    `renderer/lighting.ts`). In 2D the disc seen from a sample is a line across the sight line to it: sight lines to
    its two ends; where they disagree, 5 halvings find the cut and the share is the disc's area on the seen side.
    The wall and floor lamp lists keep that share (`wallLampSeen`, `floorLampSeen`), so reflections fade with the
    shadow. *Amended 2026-10-16:* walls only used it to pick their lamp, and drew its reflection at full
    strength however little of it they saw; they now dim it by that share, as the floor does. They also no longer show
    one lamp per column: at each of the column's 17 heights it is the brightest of the lamps worth showing, as the
    floor picks per sample. A column that showed only the lamp with the brightest peak switched every height at once
    where one lamp's reflection took over from another's along a wall, and left a seam (LEVEL1's corridor south of the
    lower wood room, between its two lamps). Baked, so nothing per frame; the LEVEL1 bake grows by about 8 ms (69 → 77 ms in an esbuild bundle).
    Shadow edges are still on the floor's 1/8-tile cells, now as a gradient. The bounce bake and the voxels' per-frame
    light keep hard sight lines.
  - **Voxel objects cast lamp shadows and show in the floor** (2026-10-23, spec
    `docs/superpowers/specs/2026-10-23-voxel-shadows-and-mirror-design.md`). Each lamp near an object darkens the floor
    cells the object hides from it, per frame, in patched copies of the floor tables (the avatar glow's path,
    `renderer/object-shadows.ts`): the share is sampled at 13 points across the lamp's disc against the model's
    top-down column heights, so the sides and the tip are soft, on the same 1/8-tile cells as the walls' shadows. The
    cell's `floorLampSeen` shrinks by the same share, so the floor's lamp reflection is cut there too; the floor light
    ends at the lamp's radius but its reflection doesn't, so the cut eases out between 1 and 1.5 radii from the lamp
    instead of stopping at a hard row. Shadows stay on
    the floor (a long ball shadow stops at a wall's base), and none where no lamp reaches: the round contact shadow
    went (product owner: "let em float"). The floor also mirrors each object: drawn upside down in its lit colours
    (models gained bottom faces for it), box-blurred 0.06 tiles and fading out by `REFLECTION_RANGE`, in reflection
    modes `both` and `only`. The image hides the floor's lamp reflections behind it (a dark blurry ball in a lamp's
    streak, as the product owner expected once they saw it in game), then adds 30% of its own colour; first built as a
    10% mix over the floor, which was invisible in play. Cost (`pnpm bench:sprites`, LEVEL1 at 640×360, about 1.3 objects a pose):
    lit `renderWalls` 1.45 → 1.54 ms with shadows, 1.83 ms with the mirror too (before the cut's longer reach,
    unremeasured). The worst case is a near object: one ball 2–3 tiles off costs about 0.36 ms, nearly all of it the
    mirror's blur, which scales with its screen area. Shadow darkness, mirror strength and blur are untuned by eye.
  - **The floor mirrors everything** (2026-10-23, spec `docs/superpowers/specs/2026-10-23-floor-mirror-design.md`;
    product owner: "the floor reflects everything in the same way"). Walls (copied flipped from the drawn frame under
    each wall's foot, so no new rays), people (their discs upside down, unlit like the faces) and voxel objects go
    into one frame layer (`renderer/mirror.ts`), blurred once at quarter resolution by 0.06 tiles of the floor each
    image lands on, faded by that floor's distance out to `REFLECTION_RANGE`, and added at 30%. People's and objects'
    images hide the lamps' floor streaks behind them; walls' never do, as every lamp hangs in front of the wall behind
    it. Cost: about 0.37 ms in `bench:walls` (`both` 1.16 → 1.53 ms, measured under load); at half resolution it was
    0.6 ms.
  - Not done yet: rooms get no lamps of their own.

### D25 — A ray-traced renderer
- *Resolved 2026-10-17, reversed 2026-10-19*: a second, switchable renderer that lit the room by baked rays from the
  lamps ("Ray traced (alpha)" in the Lighting menu) was built and shipped as an alpha.
  - **Dropped 2026-10-19** (owner: "we aren't going forward with it"): `renderer/traced/`, its mode, bench, spike,
    spec and plan are removed. D24's lit renderer is the only one. A browser that saved the traced mode loads the
    default ("Shadows and reflections"). The touch tray's Lighting button, added with it, stays.

### D26 — The ball, the first interactive object
- *Resolved 2026-10-23* ([spec](superpowers/specs/2026-10-23-ball-design.md)): every room gets a ball. People dribble it
  by walking into it and kick it with Space (a kick button on phones, shown while it is in reach). It stays on the
  floor: friction, bounces off walls, people and the vacuum, no height.
  - **Server authoritative, client predicted** (owner's pick over a server-only ball, which made dribbling lag, and
    last-toucher authority). The shared physics (`packages/shared/src/objects/ball/`) runs in `Lobby.stepWorld` and in
    every client (`game/ball-prediction.ts`). The client applies only the local player's touches, ignores the server
    for 300 ms after them, and otherwise eases onto the server's ball. A kick is echoed with the kicker's id and kick
    counter so the kicker knows when the server has it.
  - **The vacuum kicks it** (owner): a vacuum driving into the ball knocks it off at 2.5 tiles/s or more. The vacuum
    itself doesn't react.
  - **Bots never touch it,** for the same reason they never bump the vacuum.
  - **It rolls by recolouring:** the voxel renderer only turns models about the vertical, so the sphere stays put and
    its football pattern turns.
  - **Sound:** a thump on a kick, a tap on a bounce, under voices (`BALL_GAIN`). Bounces play from the local ball only.
  - No goals, scores or other game rules, and no `PROTOCOL_VERSION` bump (older tabs ignore the new kind).

### D27 — Portal doorways on Y

- *Resolved 2026-10-28* ([spec](superpowers/specs/2026-10-28-portal-doorways-design.md)): anyone in a room presses Y and
  every doorway becomes a one-way portal for everyone, until someone presses Y again. The wiring (each doorway's
  destination) is fixed per room by the room id, so people can learn the maze and tell each other the way. It is a
  shared toy, not a game rule. Rationale: the map is fixed and small, and bending it is the cheapest way to make the
  same room new again; making the wiring a pure function of the room id keeps the wire to one boolean.
  - **Server owns the flag,** like the vacuum and the ball: one flip per room per 1000 ms, saved in the state file
    (`LobbySnapshot` stays version 1, the field is optional), sent in the welcome. `PROTOCOL_VERSION` 3 → 4.
  - **Wiring is local.** Server and clients compute it from the room id (`wirePortals`); nothing about it is sent.
    `portals === null` everywhere means today's behaviour, pixel for pixel (`pnpm bench:walls`/`bench:sprites` hashes
    are unchanged with portals off).
  - **Drawing re-runs the passes** from the eye carried through each portal, for the window's columns only, two levels
    deep (the third is black; pink-tinted black since D29). Every pass takes a `Pass` (columns and a near limit), so a
    new pass must honour it.
  - **Hearing and subscribing** use the apparent position: up to two portals whose front faces the listener and whose
    centre is within `NEAR_TILES`.
  - **Near or far is one rule** (`isNear` in `packages/shared/src/portals/apparent.ts`), used by the server's fan-out
    and by the client's interpolation tiers alike: near when within `NEAR_TILES` in a straight line *or* where the
    person appears. The straight check comes first, so most pairs never search the portals; the client judges a tile
    inside the line, as before.
  - Amendments to the spec and known gaps, all deliberate:
    - **The vacuum ignores portals** (ordinary doors for it). Portal-unaware navigation stalled cleaning, and the spec
      left it to the builder with "keep cleaning and find the dock". A vacuum crossing a front-facing doorway vanishes
      into the window instead of coming out of the destination.
    - **Occluded chains still count:** a person behind a wall but seen along a portal chain is heard near and muffled
      (spec §2.6 over the brief's "both legs are lines of sight"), so hearing matches what is drawn.
    - **The main-pass floor mirror shows nothing of a window** (its columns are skipped); the window's own pass
      mirrors what it shows. Floor shadows take no near limit and are never copied back from a window pass.
    - **With portals off, a local teleport over 2 tiles** zeroes the ball body's velocity and peers snap instead of
      gliding: a tiny change to today's behaviour that falls out of the shared jump handling.
    - **Fan-out costs more with portals on** (the apparent-position search per pair): measured below.
  - **Measured** (2026-10-28, against base 0572557, origin/main when the branch was cut; LEVEL1 at 640×360, lit, reflections `both`; the machine was loaded, read the ratios):
    - `bench:walls`, existing modes with portals off: unchanged hashes, `both` 1.51 ms on the base vs 1.56 ms here.
      From 1.5 tiles in front of 8 doorways: `renderWalls` 1.58 ms off, 0.92 ms on (the window passes are cheaper than
      the corridor they replace, which the main pass draws in full when off). With 100 glows spread over the map, from
      the lamp poses (most show no window): 2.49 ms off, 2.73 ms on. The floor tables skip what is out of view unless
      the frame's first pass shows a window (then a window may look anywhere); before that, every frame with portals on
      lit the whole map's floor, 4.04 ms. Pixel hashes with the crowd (lamp and doorway poses) are the same either way.
    - `bench:sprites`, hashes unchanged, `renderSprites` 392 / 396 µs on the base vs 395 / 397 µs here (unlit / lit).
      Whole frames (`renderView`) from the same doorways with people and a vacuum ahead: 2.29 ms off, 2.65 ms on.
    - Server tick (`pnpm bench:tick`, `apps/server/bench/tick.ts`: `Lobby.stepWorld` + `fanOut`, Node, one room with 100 bots, no sockets or JSON, so the
      serialisation is not counted; 600 ticks, bots and people walking): 4 connected people, `fanOut` 0.01 ms off vs
      0.21 ms on; 100 connected people, 0.29 ms off vs 6.05 ms on (p99 6.98 ms), `stepWorld` under 0.1 ms both ways.
      Before the straight-line check came first (`isNear`), the same run gave 13.7 ms on (p99 15.0 ms) for 100 people:
      the apparent-position search ran for pairs that were near anyway.
    - Not done: the browser run with `?bots=100` (walking through doorways, comparing the view to where it leads, the
      server's `/metrics` tick time under real load). The e2e spec `apps/web/e2e/portals.spec.ts` covers the flip.
  - Not done: an interactive element that uses portals; a map editor's doorway choices; the vacuum going through.
  - The baked lamp light follows the portals since D28; moving shadows and avatar glow through portals don't yet.

### D28 — The baked lamp light follows the portals

- *Resolved 2026-10-29* ([spec](superpowers/specs/2026-10-29-portal-lamp-light-design.md)): with portals on, the lamp
  light around a doorway matches what is seen through it. Before, the floor and walls in front of a doorway glowed with
  the lamps of the room physically behind it, a room that is no longer there, and the lamps of the room seen through it
  lit nothing on this side. Press Y and the light changes along with the space.
  - **The rule: light follows sight.** A spot is lit by the lamps it can see, the way it sees them: a sight line that
    crosses a doorway front to back carries on from the destination, as a view ray does; one that crosses back to front
    is ordinary. So the light has a step at a window: looking through A from its front, the light of the viewer's side
    ends at A's plane and B's back side has only its own. The owner chose this after trying both rules in a throwaway
    demo. Their reason: light from room Y can't reach room W, because from W the room Y isn't visible.
  - **Rejected, rule 2:** join each doorway with its destination both ways, so the light carries on across the window.
    B's back side would then glow from a room that can't be seen from there: the spill this removes, moved to the
    arrival side.
  - **Copies through one portal.** With portals on, every lamp lying behind a destination and within `LAMP_SIGHT` of it
    also appears as a copy where it is seen from the portal's front (`lampCopies`, `Light.through`). A spot sees a copy
    only along a line through that doorway (`seesLamp`, `hasLineOfSightThrough`); the doorway's edge softens a copy's
    light as a wall's edge does a lamp's. A lamp seen through two doorways in a row lights nothing: one level keeps the
    copies and the bake time down. Copies show no ceiling fixture; the window's own pass draws the real one.
  - **Everything reading the lamp list follows:** reflections, the lighting on people, the vacuum and the ball
    (`directLight`), and the object shadows' fallback sight test, all through `seesLamp`.
  - **A second table per room,** `bakePortalLighting`, baked per room id (`roomLightingByRoom`) in an idle moment
    while the room's lobby is open, or at the latest in `joinRoom`, before the connection starts. In the Join click the
    two bakes (about 0.4 s) froze the lobby and held up the connection. So it is ready before any welcome can turn
    portals on, and Y swaps tables in the same frame. The plain table stays baked once per page, now from the lobby
    too. The bounce light is the plain table's own array, reused: it is faint and spread over two tiles.
    `describeScene` picks the table for every pass, windows included.
  - **The lamp lists widened** from signed bytes (127 lamps) to `Int16Array` (`MAX_LAMPS` 32767): LEVEL1 has 37 lamps
    and 101 copies.
  - **Measured** (2026-10-29, against base `2f50798`; LEVEL1 at 640×360, lit, reflections `both`, a loaded machine,
    read the ratios): the portals-on bake takes 255 to 272 ms cold, with 101 copies of 37 lamps, against 125 ms for the
    plain bake (121 to 128 ms before), so no pruning of copies was needed. Both are baked in an idle moment in the
    lobby, not in the Join click. With portals off nothing changed: the `bench:walls` lighting, pixel, doorway and
    crowd hashes and the `bench:sprites` hashes are the same as on the base. Two runs each, agreeing to 0.02 ms:
    `renderWalls` from 1.5 tiles in front of 8 doorways, 1.68 ms off, 1.00 ms on (0.92 on the base; an earlier 1.79 ms
    off was noise). With the 100-glow crowd, from the lamp poses: 2.55 ms off, 2.85 ms on (2.73 on the base). Whole
    frames (`renderView`) from the doorways: 2.38 ms off, 2.78 ms on (2.65 on the base).
  - Not done: moving shadows and avatar glow through portals; bounce light through portals; lamp light through two
    portals; a browser run by eye of the light across a window.

### D29 — Portal windows shimmer, glow and hum

- *Resolved 2026-10-29* ([spec](superpowers/specs/2026-10-29-portal-glow-design.md)): with portals on, each doorway
  window shimmers, its front spills a pulsing pink light, and each doorway hums. A doorway now reads as a gateway
  before anyone looks through it, and from a distance. The owner picked the look in a throwaway sketch.
  - **What was picked:** both window styles (the shimmer and the lit rim), one pink for all doorways, a pulse of 0.8 Hz
    at 40% depth (`game/portal-pulse.ts`), and the hum's mix under voices (`HUM_GAIN` 0.04, equal to `VACUUM_GAIN`).
  - **The spill is cut at the plane.** A portal glow is an avatar glow with a `cut` plane (`Glow.cut`): it lights
    only the front side of its doorway, so the floor and walls behind it stay as they were. Plain glow was rejected: it
    would also have lit the back side, the room the window replaces, which is the spill D28 removed.
  - **The light sits 0.6 tiles in front of the plane,** so the spill reaches the floor and the frame instead of
    dying inside the doorway's own wall thickness.
  - **No glow on people or objects,** and the ceiling goes pink with the floor. People and objects are drawn
    unchanged; only the walls, floor and ceiling take the spill.
  - **One clock for glow, shimmer and hum.** The pulse is computed once per frame from the local clock and is never
    sent, so the three never drift apart. Peers see their own phase, which is fine: it is decoration, not state.
  - **The rim has a cutoff.** It is skipped past about 13.7 sketch px from the opening, where it adds under half a
    level. The top and bottom rim are measured from the opening's unclamped bounds, so they don't slide when the
    opening runs off the screen.
  - **Amends D27:** a window past the last level is not pure black but pink-tinted black, because the levels above it
    tint it. D27's "the third is black" no longer holds to the letter.
  - **The hum:** one source per portal, placed through `placeApparently` and swelled each frame by the renderer's own
    pulse. `PortalHums.dispose()` exists and is tested, but nothing calls it: no `Room` is ever disposed. A quick
    off then on can't cut a hum's fade short, because the server allows one flip per room per 1000 ms, longer than the
    fade.
  - **A hum plays only in hearing range** (spec §6 left it to the builder). Each hum is 2 oscillators, a filter, the
    engine's HRTF panner and a reverb send, so all 24 of LEVEL1's ran even far beyond hearing. Now a doorway's hum
    starts (fading in) when its apparent position, the one `placeApparently` computes, comes within the engine's
    silent distance (`settings().max`, 24 tiles), and fades out and detaches 1 tile past it, so pacing about the edge
    doesn't restart it. Past that distance the engine's gain is already 0, so the fade out is silent, and a hum
    re-entering while its old one still fades can replace it without a click. From 2000 random open spots on LEVEL1,
    a median of 10 of the 24 doorways are in range (90th percentile 14, at most 19).
  - **Levels, tuned by eye while playing locally (2026-10-29).** `PORTAL_GLOW_STRENGTH` stays at 0.9 (0.5 was tried
    and was too faint). The window's shimmer is half the sketch's, `k = 0.08 + 0.1·pulse + 0.05·ripple`, so the room
    seen through it is clearer. `HUM_GAIN` (0.04) is still the first guess, awaiting a listen.
  - **Measured** (2026-10-29, against D28's numbers; LEVEL1 at 640×360, lit, reflections `both`, medians of three runs
    each, a loaded machine, read the ratios). With portals off nothing changed: the `bench:walls` pixel (-601092469),
    doorway (-1246551896) and crowd (2075427884) hashes and the `bench:sprites` hashes (1236007431, doorway scenes
    -1373330069) are the same as before.
    - `renderWalls` from 1.5 tiles in front of 8 doorways: 1.68 ms off, 1.00 ms on (D28: 1.00 on).
    - With the 100-glow crowd, from the lamp poses: 2.55 ms off, 2.86 ms on (D28: 2.85 on).
    - Whole frames (`renderView`) from the doorways with people and a vacuum ahead: 2.36 ms off, 4.13 ms on (D28:
      2.78 on). The glow, the shimmer and the rim cost about 1.35 ms more than D28's portals-on frame.
  - **Where the frame cost goes, and the fix** (final review, 2026-10-29; `pnpm bench:sprites` `renderView` from the
    doorway poses, portals on, medians of three runs, each part measured by switching it off):
    - **The spill was about 0.8 ms** (0.79 ms here), **about 0.63 ms of it the floor and ceiling's `addGlow`**: once
      the frame's first pass showed a window, every glow on the map went through `addGlow`'s cell box, all 24 portal
      glows included.
    - **The shimmer and rim are about 0.6 ms** (0.57 ms here; the review measured 0.67), per pixel shown through a
      window. Left as they are.
    - **The fix:** the floor tables now skip a glow (and an object's shadow) unless some pass's eye may see it: the
      frame's own, the eye carried through each window its first pass shows, limited to that window's columns, and
      from those, the eyes through every window they may show (from a doorway's front with its opening in their
      columns), down both levels (`renderer/frame-eyes.ts`). It is conservative: every pixel hash is unchanged.
      `renderView` portals on went from 4.11 ms to 3.85 ms; the spill from 0.79 ms to 0.52 ms. About 70% of the glows
      still pass in these poses: the eyes through windows look down long corridors, and the test is by view, not by
      occlusion. Amends D27, whose floor tables lit everything once a window showed.
    - `bench:walls` lit no portal glow before (its portals-on passes took only avatar glows). Its portals-on doorway
      and crowd passes now take the portal glows too, so a spill regression shows there: their hashes moved from
      1272589417 to 482093256 (doorway) and from -1861553458 to -1819097756 (crowd), and the portals-off hashes are
      unchanged. With the halved shimmer, the `bench:sprites` doorway scenes with portals on hash to -1101303808. With the spill, `renderWalls` from the doorways, portals on, takes 1.60 ms (1.83 ms before the fix),
      and with the crowd from the lamp poses 2.89 ms (3.19 ms before).
  - **Portal glows cast baked soft shadows** (amended 2026-10-29, the user's call). A screenshot showed a doorway in
    a recess lighting the floor and the side face of the block beside it, through the block. Now a floor cell, ceiling
    cell or wall sample gets a portal glow's light only as much as it sees the glow's disc, as a lamp's (`seenShare`,
    soft edges across `LAMP_RADIUS`). A portal glow never moves, so the share is baked per portal with the portals-on
    lighting (`Lighting.portalGlowSeen`, one byte per floor cell within GLOW_RADIUS) and `glowLight` multiplies by it;
    a wall sample reads the cell just in front of the wall. Avatar glows carry no table (`Glow.shadow` null) and light
    as before. Unlit rooms have no table, and no glow light at all.
    - **Bake:** 24 portals, about 15,300 cells, 6.5 ms cold (1.5 ms warm) on top of `bakePortalLighting`'s ~255 ms,
      still in the lobby, so Y never waits.
    - **Frame cost:** none to speak of (medians of three runs, against the commit before): `renderWalls` from the
      doorways, portals on, 1.61 ms (1.56 before), crowd 2.97 ms (2.83). Portals off moved too (1.73 vs 1.68, 2.70 vs
      2.65), so the doorway change is the machine and the crowd's at most about 0.1 ms. `renderView` from the doorways, portals on, 3.84 ms (3.80).
    - **Hashes:** every portals-off hash is unchanged. Portals on, `bench:walls` doorway moved from 482093256 to
      -589436950 and crowd from -1819097756 to 2005369998; `bench:sprites` doorway scenes from -1101303808 to
      -198097577.
  - Not done: glow on people and objects; a hue per doorway; the hum through two portals; a listen by ear.

## Resolved
_(none yet)_
