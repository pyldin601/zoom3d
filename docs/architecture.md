# Architecture (DRAFT — provisional, pending open decisions)

## Components
```
Browser client                              Backend (TBD)
+-----------------------------+            +--------------------------+
| Input -> Local player state |            | Room mgmt / invites      |
| Raycaster renderer          |<-- WS ---->| Signaling (SDP/ICE)      |
| Avatar billboards (video)   |            | Presence + position relay|
| WebRTC peers (A/V)          |            | (maybe) SFU or TURN      |
| Spatial audio graph         |            +--------------------------+
| Map loader / collision      |
+-----------------------------+
        ^  WebRTC media (P2P mesh or via SFU)  ^
```

## Rendering
- Classic DDA ray-casting over a 2D grid map; render at low internal resolution
  (e.g. 320x200 – 640x360) and upscale with nearest-neighbour for the retro look.
- Avatars: billboards sorted far-to-near, clipped per column by the wall z-buffer
  (the classic sprite technique). Round mask applied to the video frame; size by distance.
- Video frames: copy `<video>` to a small offscreen canvas/texture at reduced rate
  (e.g. 15 fps, 64–128 px) — far avatars need few pixels.
- Options: Canvas2D/ImageData software raycaster vs WebGL fragment-shader raycaster (see decisions).

## Networking
- WebSocket to backend: join room, signaling, player state (pos, angle, speaking, mute).
- State updates ~15–20 Hz with client-side interpolation; deltas not needed at this scale.
- Media: WebRTC. Topology is an open decision (mesh vs SFU).

## Spatial audio (Web Audio)
Per remote participant:
```
MediaStreamSource -> Gain(distance curve) -> Panner (HRTF or StereoPanner)
   -> dry bus ----------------------------> master
   -> Convolver (room IR) -> wet Gain(distance-dependent) -> master
```
- Distance: gain falls with distance (inverse/linear-clamped), hard cut-off beyond max range.
- Pan/surround: from bearing relative to listener facing. Listener orientation updated per frame.
- Reverb: shared room impulse response; wet/dry ratio increases with distance (far = more reverb).
- Optional: wall occlusion — ray between speaker and listener; if blocked, low-pass + extra attenuation.
- Optional: per-room "acoustics" preset (small room, hall) swapping the IR.

## Map
- Grid of cells (wall type ids / empty), spawn points. JSON in `packages/shared`.
- Static for v1; hand-authored or generated maze. Editor is out of scope.

## Testing
- Unit: raycaster math, collision, gain/pan curves, protocol (pure functions).
- E2E: Playwright with Chromium fake media devices, 2–3 clients against a local server.
