# Dynamic subscription (step 6c) — design spec

Status: built, 2026-10-11. Decision record: [open-decisions.md](../../open-decisions.md) D21. Builds on the
[LiveKit spec](2026-10-11-livekit-sfu-design.md) (6b). Rooms stay **proximity-only** (user's call, 2026-10-11): no
stage or spotlight in M7.

## 1. Intent

Each client receives only what its player can see or hear, so LiveKit's egress (casa's upload) and each client's
download grow with what is near, not with people × people.

- **Video:** none from people you can't see; a smaller size for people who are visible but far.
- **Audio:** none from people beyond hearing range.
- **Senders:** pause any face size nobody receives (dynacast), saving their upload, CPU and battery.

### Non-goals
- Server-enforced subscriptions or permissions (a modified client could still subscribe to everyone).
- Batched game state, avatars over HTTP, the people cap (6d).
- A stage or spotlight.

## 2. Spike findings (2026-10-11, throwaway, local LiveKit 1.13.9, Chrome)

| Approach for 256/128/64 faces | Result |
|---|---|
| Simulcast (`simulcast: true`, 3 presets) | **One layer only.** `livekit-client` disables simulcast below 480 px (2 layers ≥ 480, 3 ≥ 960). |
| VP9 SVC (`L3T3_KEY`) | Configured, but the subscriber got 256² at every requested size: Chrome won't split a source this small into spatial layers. |
| **Separate tracks** (`face` 256, `face-64` 64) + dynacast | ✅ Unsubscribed tracks pause (0 kbps) and resume on subscribe. Each sender uploads only the sizes someone receives. |

So the face is published as **three separate tracks**. A new track sends for its first ~10 s even if nobody
subscribes: LiveKit waits that long (`initialQualityUpdateWait`) before telling the sender that no one is subscribed.
Then it pauses, so someone alone in a room uploads only their mic. (The first spike measured at 4 s, before the
pause, and wrongly concluded that unsubscribed tracks keep sending; re-measured 2026-10-11: 0 kbps from ~12 s.)

## 3. Publishing (sender)

| Track | Source | Size | Frame rate | Bitrate cap |
|---|---|---|---|---|
| `face` | the framer's canvas (as today) | 256² | 24 | 350 kbps |
| `face-128` | a 128² canvas drawn from the framer's canvas each frame | 128² | 24 | 120 kbps |
| `face-64` | a 64² canvas drawn likewise | 64² | 15 | 35 kbps |

- All three are published with `simulcast: false`. Only `face` carries `source: Camera`; the other two use
  `Unknown`, so LiveKit's UI semantics (one camera per participant) stay true.
- Room option `dynacast: true` (was false in 6b): LiveKit pauses any of the three that nobody receives.
- **Hidden tab:** the framer's canvases freeze when the tab is hidden, so, as today for `face`, all three switch to
  the raw camera track. `face-128` and `face-64` then set `scaleResolutionDownBy` on their sender so the encoder
  scales the camera to their size (removed again when the tab is visible). Receivers centre-crop as today.
- Mic and boombox are published as in 6b.

## 4. Deciding what to receive

### 4.1 Facts (from the UI)
- **Renderer (sprite pass):** per peer, written into a reused array (no allocations per frame):
  - `drawnColumns`: disc columns seen this frame: in front of the walls and not hidden behind a nearer disc (a
    farther disc's column counts only where its slice is taller than every nearer disc's there; all discs sit on the
    eye line). 0 = not on screen, or fully hidden;
  - `projectedSize`: the disc's diameter in framebuffer pixels (what the face texture is actually sampled at).
- **Positions:** the interpolated positions the frame loop already computes (`positions`).
- **Hidden tab:** `document.hidden`.

### 4.2 The rule (`apps/web/src/media/interest.ts`, pure)
Runs about every 250 ms (`INTEREST_MS`), from the frame loop and the hidden-tab ticker. Inputs: the player pose,
peers' positions, the facts, the map, the audio settings (`max`), `hidden`, the current wants, and `now`. Output:
per peer `{ video: 'off' | 64 | 128 | 256, audio: boolean }`.

- **Video wanted** when not hidden and either:
  - `drawnColumns > 0`; or
  - **look-ahead:** within `LOOKAHEAD_TILES = 20` tiles, within the field of view widened by `LOOKAHEAD_DEG = 15°`
    on each side, and in line of sight (`hasLineOfSight`, the audio occlusion test). Inside the real field of view
    look-ahead only covers peers the renderer hasn't reported yet: once a frame has drawn none of a peer there, they
    are hidden (behind someone nearer) and get no video.
- **Size**, from `projectedSize` (framebuffer px), with 20% hysteresis around each threshold:
  - ≥ 128 px → 256; ≥ 48 px → 128; otherwise → 64 (also for look-ahead peers not drawn yet).
- **Delays:** going up (off → on, or a bigger size) happens at once; going down (smaller, or off) only after the
  lower value has been wanted continuously for `HOLD_MS = 1000`.
- **Audio wanted** while within `max + 2` tiles; dropped beyond `max + 4` (hysteresis). Mic and boombox follow it.
- **Caps:** at most `MAX_VIDEOS = 12` videos and `MAX_VOICES = 24` voices, nearest first; the rest are off. Only
  peers that publish media enter the rule (`Call.publishes`), so bots never take a slot.
- **Hidden tab:** video off for everyone at once (no hold); audio unchanged.

### 4.3 Applying it (`media/livekit.ts`)
- Room `autoSubscribe: false`. The transport gets `setWanted(peerId, want)` and subscribes per publication:
  - video: exactly one of `face` / `face-128` / `face-64`, by size; if a peer doesn't publish that size (an older
    client: only `face`), the nearest available size;
  - audio: `mic` and `boombox` together.
- **Make-before-break size switches:** subscribe the new size; once its track arrives, emit the peer's stream with
  it and unsubscribe the old one. The face never goes blank during a switch.
- **Face and voice are separate streams** (`onRemoteStream` carries only the shown face, `onRemoteVoice` the mic,
  each re-emitted only when its own track changes). The audio engine rebuilds a voice for every new stream object, so
  with one combined stream every turn, size switch and tab switch would dip the voice.
- `stats(peerId)` keeps summing whatever is subscribed.

### 4.4 Faces while paused
When a peer's video is off on purpose (out of sight), its face keeps the **last frame** instead of falling back to
the avatar after `FACE_STALL_MS`, so it reappears with a face the moment it comes into view, then updates when video
resumes (`FaceSource.setPaused(true)`). A peer never seen yet shows its avatar or initials, as today. A new video
(a size switch) or a resume holds the last frame until the new frames arrive, for up to `FACE_STALL_MS`.

## 5. Expected effect

A person in a crowded room with ~12 faces in view (3 close, 5 mid, 4 far) receives ≈ 3×350 + 5×120 + 4×35 ≈
**1.8 Mbps** of video instead of 350 kbps × everyone. Voices beyond `max + 4` tiles cost nothing. LiveKit's egress
per person stops growing with room size.

## 6. Testing

- **Unit:**
  - `interest.ts`: every rule above, including hysteresis, holds, caps, the hidden tab and look-ahead through
    a doorway vs a wall;
  - the renderer facts on a real framebuffer (in view, behind a wall, half behind a corner, behind the camera);
  - the transport against the fake room: three publications with their encodings, `setWanted` → `setSubscribed`,
    make-before-break, the fallback size, dynacast on, hidden-tab scaling;
  - faces' paused mode.
- **E2E (local LiveKit):** two people; Bob turns away from Ada → Ada's video for Bob stops after ~1 s (bytes stop
  growing) and resumes when he turns back; the face size follows distance; the existing 36 specs still pass.
- **Measure on casa:** with three real browsers, the dashboard's LiveKit egress before/after.

## 7. Rollout

Client-only (the server is untouched). Mixed versions during a deploy: old clients autoSubscribe to everything and
ignore the unknown `face-128`/`face-64` names; new clients fall back to `face` for old publishers. Open tabs need a
reload to get the savings.
