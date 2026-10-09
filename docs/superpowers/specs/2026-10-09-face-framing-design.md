# Face framing — design spec

Status: approved design, 2026-10-09. Decision record: [open-decisions.md](../../open-decisions.md) D7.

## 1. Intent

Today the camera itself centre-crops to 256×256 (`resizeMode: 'crop-and-scale'`), so a person who sits
to one side or far back shows up off-centre or small on their disc. Face framing finds the face in the
sender's camera frame and crops a square around it, so every disc shows a **centred face at a
consistent size**: it pans and zooms.

In scope:
- Sender-side face detection (MediaPipe Face Detector) and a smoothed crop.
- Always on, with no UI. Any failure falls back to today's centre crop without a banner.
- Keeping your video live while your tab is in the background.

Out of scope:
- A user toggle, background removal, landmarks or head pose.
- Receiver-side cropping. Peers keep receiving one 256² video track, as today.
- Moving the pipeline off the main thread (insertable streams in a worker). Revisit only if profiling
  shows main-thread jank (§8).

## 2. Data flow

```
getUserMedia (640×480, 24 fps) ──raw track──► framer ──framed 256² track──┐
                                                │                          ├─► LocalMedia.stream ─► mesh, self-preview
                                     face detector (≈5 Hz)       audio ────┘
                                                │
                                     framing: face box → smoothed crop rect
```

Downstream code (mesh, `showSelfPreview`, `call.setCam`) keeps consuming `LocalMedia.stream`. The
self-preview therefore shows the framed view, which is what others see. Bandwidth is unchanged: one
256² track at 24 fps, capped at `VIDEO_MAX_BITRATE`.

The draw always goes through the canvas, even with no detector. "No face yet", "face lost" and "model
failed to load" all mean the same thing: the centred square.

## 3. Framing math (`apps/web/src/media/framing.ts`)

Pure logic with no DOM, written test-first. All values are in source pixels and are named constants.

```ts
interface Box { x: number; y: number; w: number; h: number }   // detector face box
interface Rect { x: number; y: number; size: number }          // square crop in the source frame
createFraming(frameW: number, frameH: number): { update(face: Box | null, now: number): Rect }
```

- **Target side:** `FACE_SCALE = 2.2` × face box width.
- **Target centre:** the face box centre, moved up by `HEADROOM = 0.1` × side.
- **Zoom limits:** the side is clamped to `[MIN_SIDE = 160, min(frameW, frameH)]`. 160 px caps upscaling
  at 1.6× into the 256² output. A far-away face is framed as close as quality allows, no closer.
- **Clamp:** the square is shifted to lie inside the frame. It is never padded.
- **Dead zone:** the target is not replaced while the new target's centre is within `DEAD_MOVE = 0.06`
  × the old target's side of the old target's centre, and its side is within `DEAD_SIZE = 0.1` of the
  old target's side (both measured after clamping).
  This stops detector noise from wobbling the crop while the person sits still.
- **Easing:** the current rect approaches the target with `k = 1 − exp(−dt / EASE_MS)`, where
  `EASE_MS = 300`. The easing runs on every `update()`, and it's time-based, so it doesn't depend on
  frame rate. The target only changes when a box is passed in.
- **Lost face:** a `null` box doesn't move the target. After `LOST_MS = 1500` without a box, the target
  becomes the centred `min(frameW, frameH)` square, today's crop, reached with the same easing.
- **Start:** the rect starts at the centred square, so there's no jump before the model loads.
- **Allocation:** `update()` returns the same rect object every call. Callers must not keep it.

The caller picks the largest box when the detector reports several faces (§4).

## 4. Face detector (`apps/web/src/media/face-detector.ts`)

A thin wrapper around `@mediapipe/tasks-vision` (Apache-2.0), using the BlazeFace short-range model.

```ts
interface Detector { detect(video: HTMLVideoElement, now: number): Box | null }  // largest face, or null
loadFaceDetector(base?: string): Promise<Detector | null>
```

- **Self-hosted, no CDN at runtime.**
  - `blaze_face_short_range.tflite` (about 230 KB, Apache-2.0) is committed under
    `apps/web/public/mediapipe/`.
  - The wasm loader and binary files are copied from `node_modules/@mediapipe/tasks-vision/wasm` by a
    small Vite plugin in dev and build, so they always match the installed version. Only the SIMD
    binary (about 13 MB) is fetched, once, and cached.
- **Loading:** loaded lazily after Join and never awaited by the join flow. The crop stays centred until
  it resolves.
- **Settings:** `runningMode: 'VIDEO'`, `delegate: 'GPU'`, then one retry with `'CPU'` if GPU init
  throws. `minDetectionConfidence` stays at the default 0.5.
- **Failure:** any load failure logs one `console.warn` and resolves `null`.

## 5. Framer (`apps/web/src/media/framer.ts`)

DOM and WebRTC glue. It is verified manually and with Playwright (§7).

```ts
interface Framer {
  readonly track: MediaStreamTrack;          // canvas.captureStream(24), 256²
  readonly rawTrack: MediaStreamTrack;       // the camera track
  readonly sendTrack: MediaStreamTrack;      // what senders should carry now: track, or rawTrack while hidden
  onSendTrackChange: (() => void) | null;    // set by the call; fired when sendTrack flips
  setEnabled(on: boolean): void;
}
createFramer(opts: {
  rawTrack: MediaStreamTrack;
  container: HTMLElement;                    // #local-media, a hidden box of its own
  document: Document;
  loadDetector?: () => Promise<Detector | null>;
}): Framer
```

- **Hidden video:** a muted, `playsInline`, playing `<video>` of the raw track sits in `#local-media`, a
  new box styled like `#media`. It must stay `visibility: hidden`, which is the frame-rate gotcha. It
  doesn't go in `#media`, because remote media owns that box and e2e counts its videos.
- **Draw loop:** each `requestVideoFrameCallback` runs one frame step: on detection frames it calls
  `framing.update(box, now)` with the fresh result, on other frames `framing.update(null, now)`, and then
  `drawImage(video, rect → 256²)`. The framing is built from the video's real size, and rebuilt if that
  size changes. Frames with `videoWidth === 0` are skipped. Where rVFC is missing, it polls every 42 ms instead, as `faces.ts`
  does.
- **Detection cadence:** at most once per `DETECT_MS = 200`, inside the draw callback, calling
  `detector.detect(video, now)`. If `detect` throws once, the detector is dropped for the session and
  the crop eases back to centre.
- **`setEnabled(false)`:** stops drawing and detection, and sets `enabled = false` on both the raw track
  (so the camera light goes off) and the canvas track. `setEnabled(true)` reverses it.
- **Hidden tab:** Chrome stops rVFC in background tabs, so the canvas would freeze and peers would fall
  back to the avatar after `FACE_STALL_MS`.
  - `sendTrack` is `rawTrack` while `document.visibilityState === 'hidden'`, else `track`.
  - Each `visibilitychange` fires `onSendTrackChange`.
  - While the tab is hidden, receivers' existing `squareCrop` shows the raw 4:3 frame as today's centre
    crop.

## 6. Wiring

- **`capture.ts`:**
  - `VIDEO_CONSTRAINTS` becomes `{ width: 640, height: 480, frameRate: 24 }`, with no aspect ratio and
    no `crop-and-scale`.
  - `CaptureEnv` takes an optional `frame(rawTrack) => Framer`. When it's given and a camera track
    exists, `LocalMedia.stream` becomes `new MediaStream([framer.track, ...audioTracks])`.
  - `LocalMedia` gains `framer: Framer | null`.
  - With no camera, there's no framer, as today.
- **`mesh.ts`:** `MediaTransport.setVideoTrack(track)` runs `replaceTrack(track)` on every connection's
  video sender that is currently sending. No renegotiation is needed. New connections still attach the
  stream's video track, then follow the current choice: the mesh remembers the last `setVideoTrack`
  value and uses it in `attachTracks` and in the initiator transceiver.
- **`call.ts`:**
  - `setCam(on)` also calls `local.framer?.setEnabled(on)`.
  - Right after creating a mesh in `welcome`, the call runs `mesh.setVideoTrack(framer.sendTrack)`.
  - It sets `framer.onSendTrackChange` to `() => mesh?.setVideoTrack(framer.sendTrack)`.
- **`main.ts`:** passes `frame` into `captureLocalMedia` with `#local-media` as the container.
- **`index.html`:** adds `<div id="local-media" aria-hidden="true">`, styled like `#media`.
- **nginx:** adds `location /mediapipe/ { try_files $uri =404; }` with a one-day cache. Without it, a
  missing file would be answered with `index.html` instead of a 404.

## 7. Testing (failing test first for logic)

Unit tests:
- **`framing.test.ts`:** a centred face gives the expected rect, the headroom shift, clamping at each
  edge, the zoom floor and ceiling, dead-zone stability under noisy boxes, easing convergence after
  time passes, frame-rate independence (one 300 ms step ≈ ten 30 ms steps), lost-face return to centre
  after `LOST_MS`, and a reappearing face resuming tracking.
- **`capture.test.ts`:** the new constraints, the stream wrapped with the framer track plus the original
  audio, and no framer when there's no camera.
- **`mesh.test.ts`:** `setVideoTrack` replaces the video sender on existing connections, and a later
  connection uses the chosen track (with `fake-rtc.ts`).
- **`call.test.ts`:** `setCam` toggles the framer, a new mesh starts with `framer.sendTrack`, and
  `onSendTrackChange` reaches the mesh.

Playwright:
- The existing specs keep passing. Chrome's fake camera has no face, so this exercises the "no face"
  path.
- A new check confirms the outgoing video track is 256×256 while capture is 640×480.
- `apps/web/e2e/frame-rate.spec.ts` still passes.

Manual:
- With a real camera: lean left, right and back, and confirm the disc stays centred at a steady size.
- Switch tabs, and confirm peers keep seeing you.
- Toggle the camera off, and confirm the light goes off.
- Block the wasm URL, and confirm a centre crop with one warning.

## 8. Risks

- **Main-thread cost:** about 24 small `drawImage` calls a second plus about 5 detections a second (a
  few ms each with the GPU delegate). If profiling shows renderer jank, move to the worker pipeline
  (insertable streams) that §1 leaves out of scope.
- **Download size:** about 13 MB of wasm per first visit. It is lazy and cached, and it never blocks
  joining.
