# zoom3d — Design Spec (umbrella)

- **Date:** 2026-10-08
- **Status:** awaiting review
- **Scope:** whole-product architecture and module boundaries. Each milestone gets its own
  implementation plan derived from this spec.
- **Decision log:** [../../open-decisions.md](../../open-decisions.md)

## 1. Intent

A small-group video meeting held inside a Wolfenstein-3D-style maze. Each participant is a
round avatar whose texture is their live camera face. People walk around; voices are
spatialised (distance, direction, room reverb, muffled through walls) so it sounds like the
people are in the room with you.

**Success criteria (v1)**
1. 2–8 people on different networks join via a link, see each other's faces as avatars and walk around.
2. With eyes closed (headphones) you can tell roughly where a speaker is, how far, and whether a wall is between you.
3. Steady 60 fps on a mid-range laptop with 8 participants in Chromium and Firefox.

**Out of scope (v1):** interactive map elements (doors, pickups), secret rooms, accounts,
host controls (kick/mute/lock), persistence, chat, screen share, recording, mobile/touch
controls, face tracking or background removal, more than 8 participants, Safari parity.

## 2. Decisions summary

| Area | Decision |
|---|---|
| Group size | 2–8 per room |
| Media | WebRTC P2P mesh behind a `MediaTransport` interface (SFU swap possible later) |
| Backend | Node + TypeScript, `ws`, in-memory rooms, self-hosted VPS + coturn |
| Renderer | Canvas2D software raycaster, low internal res, nearest-neighbour upscale |
| Aspect ratio | Fixed 16:9 viewport, letterboxed; HUD and overlays anchored to it |
| Authority | Client-authoritative movement; server validates speed and wall cells |
| Audio | Native Web Audio nodes: custom distance gain, HRTF panner, shared convolver, wall muffling |
| Rooms | Ephemeral, unguessable link, display name only |
| Faces | Square crop at capture (256 px, 24 fps; raised from 160 px/15 fps on 2026-10-08), round mask on receive; initials disc fallback |
| Map | Level from `docs/assets/map-reference.png`, secret rooms ignored, 3 wall zones |
| Findability | Shared spawn at the blue-diamond start + toggleable automap with named dots |
| Tooling | pnpm workspaces, Vite, Vitest, Playwright, strict TypeScript |

## 3. Repository layout

```
apps/web/         browser client
  src/game/       main loop, wiring of modules below
  src/renderer/   raycaster, sprite pass, automap, HUD
  src/input/      keyboard / pointer-lock mouse
  src/media/      capture, MediaTransport (mesh), remote stream registry
  src/audio/      spatial audio graph
  src/net/        WebSocket client, state sync + interpolation
  src/ui/         join screen, device picker, debug panel
apps/server/      WebSocket signaling + room state, TURN credential issuing
packages/shared/  pure, dependency-free: map, geometry, protocol, audio curves, constants
tools/            one-off scripts (map conversion)
docs/
```

**Rule:** anything that is math or data (raycasting, collision, curves, protocol validation,
map) lives in `packages/shared` as pure functions and is unit-tested there. `apps/*` contain
glue to browser/Node APIs.

## 4. Map

- **Source of truth:** `packages/shared/src/map/level1.ts`, an ASCII grid in an exported
  template string (`LEVEL1`) committed to the repo. A `.ts` file rather than `.txt`, so the
  browser bundle and the Node server import it without loaders. It is generated once by
  `tools/convert-map/convert.py` from the reference PNG, then hand-fixed if needed. The PNG
  stays as a reference only; `docs/assets/map-conversion-preview.png` shows the result.
- **Conversion:** a 63×57 grid, tile pitch 7.985 px, origin (1.5, 0.4), measured from the
  image. Each tile is classified from its central 4×4 pixels by dominant colour. Door lines
  that open onto undrawn areas are sealed as walls. Full parameters are in the M1 plan.
  - grey → wall type `1` (stone), brown → `2` (wood), blue → `3` (blue stone)
  - green (secret wall) → wall of the surrounding type
  - black → floor `.`; red/yellow squares → whatever tile they sit on (treat as floor if in a corridor)
  - blue diamond → spawn `S` (floor)
- **Format:** one char per tile; `.` floor, `1`–`3` wall types, `S` spawn. Parsed into
  `{ width, height, tiles: Uint8Array, spawn: {x, y} }`.
- **Invariants (tested):** rectangular; border fully walled; exactly one spawn; every floor tile
  reachable from spawn (flood fill), so no secret/sealed areas remain.
- **Spawn:** players spawn at random floor tiles within radius 2 of `S`, facing a random open direction.

## 5. Rendering (`apps/web/src/renderer`)

- **Internal buffer:** 640×360 `ImageData` (configurable down to 320×180, always 16:9), drawn
  to an offscreen canvas and scaled with `imageSmoothingEnabled = false`.
- **Fixed aspect ratio (16:9):** the game viewport never stretches or changes shape.
  - It is the largest 16:9 box that fits the window (or fullscreen), centred, with black
    letterbox or pillarbox bars filling the rest.
  - Because the aspect is fixed, the projection (FOV 66°) is identical for every window
    size, and the raycaster never adapts to the window.
  - The game canvas and HUD canvas share this one viewport box. All HUD elements (labels,
    self-preview, automap, toggles) are laid out in viewport-relative units, so they scale
    with the game and never drift into the bars or overlap differently at other window sizes.
  - The HUD canvas backing store is `box size × devicePixelRatio` for crisp text.
  - Resizing uses a `ResizeObserver` plus `devicePixelRatio` changes, recomputing the box
    only. The internal render resolution stays constant.
  - Optional "pixel-perfect" setting: snap the scale to the largest integer multiple of the
    internal resolution that fits, at the cost of wider bars. Off by default.
  - The join screen and overlays (reconnecting, errors) render inside the same 16:9 box.
- **Walls:** DDA raycast per column, FOV 66°, fisheye-corrected perpendicular distance. Textures
  are 64×64, procedurally generated per wall type at startup (no asset licensing). Side
  shading on y-facing walls, as in Wolf3D. Flat-colour floor and ceiling.
- **Z-buffer:** per-column wall distance, kept for the sprite pass.
- **Avatars (billboards):** disc of radius 0.35 tiles, centred at eye level. Sorted far to near,
  then drawn as vertical slices with `drawImage` from the peer's face canvas, skipping columns
  where the z-buffer is closer. Face canvas: 256×256, refreshed via
  `requestVideoFrameCallback` (fallback: every 66 ms), with a circular clip. Fallback face:
  coloured disc with initials. Speaking ring: outline brightness from the audio level.
- **Floor shadow:** each avatar darkens the floor within 0.3 tiles of its position, floor-cast
  per pixel and only where the floor is nearer than the column's wall. It is pixelated like a
  low-res floor texture: snapped to a 1/16-tile world grid, in 3 flat bands up to 55% darker at
  the centre. Shadows are drawn before any disc, so discs always cover them.
- **HUD layer:** a separate full-resolution canvas above the scaled game canvas, for crisp
  text. It shows name labels above avatars (projected position), the self-preview (small
  mirrored circle), mic/cam state and the automap.
- **Automap (toggle `Tab`/`M`):** top-down grid in the three zone colours, own position and
  heading, and other participants as coloured dots with names.
- **Hot path:** no allocations per frame or per column; reuse typed arrays.

## 6. Movement and input

- WASD/arrows to move and strafe, arrows or pointer-lock mouse to turn. Move speed 3 tiles/s,
  turn speed 2.5 rad/s.
- Collision: player radius 0.25 tiles against wall tiles, with axis-separated sliding.
  Avatars do not collide with each other.
- Positions use continuous tile coordinates (`x, y` floats; `angle` in radians).

## 7. Networking

### 7.1 Rooms and joining
- Room URL `/r/<roomId>`. `roomId` is 22 chars base64url (128 random bits) generated by the
  client when creating a room. The server creates a room on first join and deletes it when
  the last peer leaves (after the reconnect grace period).
- Maximum 8 peers. A 9th join gets `error {code: "room_full"}`.

### 7.2 Protocol (JSON over WebSocket, types and validators in `shared`)
Client → server:
- `join {roomId, name, resumeToken?, avatar?}`
- `state {x, y, angle, seq}`, sent at 15 Hz while moving and 1 Hz while idle
- `media {cam: bool, mic: bool}`
- `signal {to, payload}`, where `payload` is an SDP description or an ICE candidate

Server → client:
- `welcome {selfId, resumeToken, color, spawn, peers: Peer[], iceServers}`
- `peer_joined {peer}`, `peer_left {id}`
- `peer_state {id, x, y, angle, seq}`, relayed immediately
- `peer_media {id, cam, mic}`
- `correction {x, y, angle, seq}`: sent only to the sender when its `state` is rejected
- `signal {from, payload}`
- `error {code, message}`

where `Peer = {id, name, color, x, y, angle, cam, mic, avatar}`. `avatar` is a
`data:image/jpeg;base64,…` URL of a 128×128 picture (≤ 12 000 chars) or `null` (§8.1).

### 7.3 Server validation
- Names are trimmed to 1–24 chars. `roomId` must match the format above.
- Client messages are capped at 16 KB (a `join` with an avatar is ≈ 12 KB); server messages at
  128 KB (a `welcome` listing 7 avatars is ≈ 85 KB). An invalid `avatar` is dropped (the peer
  gets initials), not rejected. On resume the peer keeps its original name and avatar.
- Rate limit per socket: a token bucket at 60 msg/s with a
  burst of 200 (ICE candidates arrive in bursts). Excess is dropped; persistent abuse closes
  the socket.
- `state`: rejected if the target tile is a wall, or if the distance since the last accepted
  state exceeds `maxSpeed × dt × 1.5 + 0.5`. A rejected state is answered with the last
  accepted position as a correction.

### 7.4 Interpolation
Remote positions render ~100 ms in the past, interpolated between buffered states, with
angle interpolation along the shortest arc.

### 7.5 Reconnect
On socket loss the client reconnects with exponential backoff and sends `resumeToken`. The
server keeps the peer slot for 30 s, so others see the avatar freeze, not disappear. After
30 s it sends `peer_left`.

## 8. Media (`apps/web/src/media`)

- **Capture:** `getUserMedia({ video: { width: 256, height: 256, aspectRatio: 1,
  frameRate: 24, resizeMode: 'crop-and-scale' }, audio: { echoCancellation: true,
  noiseSuppression: true, autoGainControl: true } })`. No `canvas.captureStream()`, because
  it costs CPU and stalls in background tabs. Browsers may ignore `resizeMode` (e.g.
  Firefox), so the receiver always center-crops to a square when drawing the face canvas.
- **MediaTransport interface:**
  `connect(peerId)`, `disconnect(peerId)`, `onRemoteStream(cb)`,
  `setLocalTracks(tracks)`, `close()`. The v1 implementation is a mesh of `RTCPeerConnection`s.
- **Negotiation:** exactly one side initiates: the peer with the lexicographically greater id
  sends the first offer, and the other side attaches its tracks to the offered transceivers and
  answers. Initial glare is avoided because rolling back an offer during ICE gathering made
  Chrome stop emitting candidates (found in M3). Later renegotiations (ICE restarts) use the
  "perfect negotiation" pattern, where the smaller id is *polite*.
- **Bandwidth:** video `maxBitrate` 350 kbps per sender (≈2.5 Mbps upload with 8 people); audio is Opus with default settings.
- **ICE:** the server returns STUN plus short-lived TURN credentials (coturn
  `use-auth-secret`, HMAC over expiry and user, valid for 6 h). ICE restart on `failed`.
- **Remote streams:** each is attached to a muted, playing `<video>` element kept in the DOM
  (1×1 px, `opacity: 0.01`) so Chrome decodes it and feeds it to Web Audio. The video is
  the source for the face canvas.
- **Camera off or denied:** the video track is absent or disabled, and the receiver shows the
  peer's avatar picture if it has one (§8.1), else the initials disc. Mic denied: the user joins as a listener, shown as muted.

### 8.1 Avatar picture
- Picked on the join screen (file input, `image/*`), remembered in `localStorage`
  (`zoom3d.avatar`, re-validated on load), removable. Changing it in the room is out of scope.
- `makeAvatar(blob)` decodes the image, takes the centre square, draws it at 128×128 and
  encodes JPEG at quality 0.85, stepping down by 0.1 to 0.35 until it fits 12 000 chars.
- Sent in `join`, relayed in `Peer.avatar`. Receivers decode it with an `Image` and draw it
  into the face canvas (only ever drawn, never inserted as HTML); a picture declaring more than
  512 px a side is ignored (decode bomb). A `Peer` without the field (older server) means no picture. Face priority: live camera,
  else picture, else initials.

## 9. Spatial audio (`apps/web/src/audio`)

### 9.1 Graph, per remote peer
```
MediaStreamSource → BiquadFilter(lowpass, "muffle") ─┬─ dryGain → PannerNode → master
                                                     └─ sendGain ──→ shared Convolver → master
```
- **PannerNode:** `panningModel: 'HRTF'` (headphones) or `'equalpower'` (speakers mode),
  `distanceModel: 'linear'`, `rolloffFactor: 0`. It provides direction only; distance is our
  own curve.
- **Listener:** `AudioListener` position equals the camera position, and its forward vector
  follows the camera angle. Mapping: map `(x, y)` → audio `(x, 0, y)`. All avatars are at the
  same height.
- **Reverb:** one `ConvolverNode` with a synthesized impulse response: stereo decorrelated
  noise with exponential decay, RT ~0.8 s and a short pre-delay. It is generated at startup.

### 9.2 Curves (pure, in `shared/audio`, unit-tested)
With `d` the distance in tiles, `REF = 1.5`, `MAX = 12`, and `n = clamp((d - REF) / (MAX - REF), 0, 1)`:
- `dry(d) = (1 - n)^2`, which is 1 inside `REF` and 0 at `MAX` and beyond
- `send(d) = (0.15 + 0.35·n) · (1 - n^4)`, so it grows with distance and fades out near `MAX`
- Occluded (line of sight blocked): the low-pass cutoff goes from 16 kHz to 700 Hz, and
  `dry` and `send` are multiplied by 0.5 (−6 dB)
- Peers with `d > MAX` are silent (gains 0), but their nodes stay alive

### 9.3 Updates
- Per frame: listener pose, panner positions, and gain targets via `setTargetAtTime(τ = 0.05 s)`.
- Every 100 ms per peer: a grid DDA ray from listener to speaker (`hasLineOfSight` in
  `packages/shared`) for occlusion. While the tab is hidden, audio keeps updating from a 100 ms
  timer. Cutoff and gain transitions use `τ = 0.15 s`.
- Speaking level: an `AnalyserNode` taps each peer's source and drives the avatar ring.
- **Debug panel** (`?debug` or `` ` ``): sliders for `REF`, `MAX`, reverb level, muffle
  cutoff and attenuation, and a headphones/speakers toggle. Values persist in
  `localStorage`, guarded with try/catch.
- The `AudioContext` is created and resumed on the join button click (user gesture).

### 9.4 Known risk R1 — echo
Chrome's echo cancellation may not cancel audio rendered through Web Audio. **The audio
spike (§12) must verify this first.** Possible outcomes:
- (a) It works on speakers → no action.
- (b) It fails → headphones are required (prominent prompt at join), with a "speakers
  mode" that ducks remote audio while the local user speaks.
- (c) It fails and (b) is unacceptable → route remote audio through a
  `MediaStreamAudioDestinationNode` into an `<audio>` element and re-test.

## 10. UI flow and errors

1. **Landing `/`:** "Create room" generates a `roomId` and navigates to `/r/<id>`.
2. **Join screen `/r/<id>`:** name input, avatar picture (§8.1), camera/mic preview and pickers, headphones hint, Join button.
3. **Join click:** resume the `AudioContext`, open the WebSocket, receive `welcome`, spawn, connect to peers.
4. **In room:** game view, HUD, automap toggle, mic/cam toggles, copy-invite-link button.

| Situation | Behaviour |
|---|---|
| Camera denied/unavailable | Join with avatar picture or initials disc; banner explaining how to re-enable |
| Mic denied | Join as listener; muted icon |
| Not HTTPS (non-localhost) | Blocking message: needs HTTPS |
| Room full | Message on join screen |
| Socket drop | "Reconnecting…" overlay, auto-retry; peers see a frozen avatar for ≤30 s |
| Peer ICE failure | ICE restart; on persistent failure that avatar shows the fallback disc and "no connection" |
| Peer video stalls | Fallback disc until frames resume |
| Tab hidden | Render stops (rAF); media and sockets continue; idle `state` heartbeat keeps running from a timer, not from rAF |

## 11. Testing

- **Unit (Vitest, `packages/shared`):** DDA hits and distances on hand-made grids and golden
  cases on `level1`; collision sliding; map parser and invariants; audio curves (monotonic,
  boundary values, occlusion factors); protocol validators (accept/reject tables); state
  speed validation.
- **Server integration (Vitest + real `ws` clients):** join/welcome/peer_joined/left; signal
  relay addressing; room full; rate and size limits; wall/speed correction; resume within
  and after 30 s; room cleanup.
- **E2E (Playwright, Chromium with `--use-fake-device-for-media-stream` and
  `--use-fake-ui-for-media-stream`):** 2–3 pages in one room; each sees the others in the
  roster, receives remote tracks, and renders avatars (test hook exposing the visible sprite
  list); camera-denied path shows the fallback.
- **Viewport (unit, pure function in `shared`):** `fitViewport(windowW, windowH, dpr, pixelPerfect)`
  always returns a 16:9 box, centred, fully inside the window (tall, wide, tiny and odd sizes,
  and integer snapping). Playwright checks that the canvas box ratio stays 16:9 at three window
  sizes.
- **Performance:** a renderer benchmark on `level1` with 8 billboards. Budget: under 8 ms per
  frame on the dev machine, logged in CI (not gating).
- **Manual checklist:** spatial audio by ear (direction, distance, occlusion, reverb) with
  headphones and speakers; Firefox smoke test.

## 12. Delivery order

Each step gets its own plan. The spike is throwaway: it lives in `spikes/` and is not merged
into apps.

0. **Audio spike (throwaway):** two tabs, one P2P connection with a manual or minimal
   signaling page, the remote mic through the §9.1 graph with a draggable position, and a
   test of echo on laptop speakers vs headphones in Chrome and Firefox. Output: an R1 verdict
   recorded in the decision log.
1. **M0 + M1, single-player walk:** monorepo tooling, map conversion and invariants,
   raycaster, movement and collision, procedural textures, automap.
2. **M2, presence:** server, protocol, join flow, interpolation, coloured-disc avatars, reconnect.
3. **M3, faces:** capture, mesh `MediaTransport`, TURN credentials, face billboards, fallbacks.
4. **M4, spatial audio:** the full §9 graph, occlusion, speaking ring, debug panel.
5. **M5, polish:** device pickers, error states from §10, performance pass, Firefox fixes.
6. **M6, deploy:** VPS, HTTPS, coturn, process manager, basic logging.
