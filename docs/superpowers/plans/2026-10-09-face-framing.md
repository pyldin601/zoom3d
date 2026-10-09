# Face Framing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every avatar disc shows a centred face at a consistent size. The sender detects its face and
sends a smoothed 256² crop around it.

**Architecture:**
- The camera is captured at 640×480 and played into a hidden `<video>`.
- A per-frame step runs MediaPipe Face Detector about every 200 ms. A pure framing model turns the box
  into an eased crop rect, which is drawn into a 256² canvas.
- `canvas.captureStream(24)` becomes the video track of `LocalMedia.stream`.
- In a hidden tab the mesh's senders swap to the raw camera track, because rVFC stops.

**Tech Stack:** TypeScript, Vite 8, Vitest 5 (happy-dom where DOM is needed), Playwright,
`@mediapipe/tasks-vision` 1.1.0.

**Spec:** [docs/superpowers/specs/2026-10-09-face-framing-design.md](../specs/2026-10-09-face-framing-design.md)

## Global Constraints

- Code style is Biome: 120 columns, single quotes, semicolons, `es5` trailing commas, and braced
  bodies for every `if`/`else`/`for`/`while`. Run `pnpm exec biome check --write .` before each commit.
- No allocations in the per-frame path. `framing.update()` returns one reused rect object.
- Framing constants (source px): `FACE_SCALE = 2.2`, `HEADROOM = 0.1`, `MIN_SIDE = 160`,
  `DEAD_MOVE = 0.06`, `DEAD_SIZE = 0.1`, `EASE_MS = 300`, `LOST_MS = 1500`.
- Framer constants:
  - `OUTPUT_SIZE = 256`, `OUTPUT_FPS = 24`, `DETECT_MS = 200`.
  - Poll fallback `42` ms when `requestVideoFrameCallback` is missing.
- Capture constraints: `{ width: 640, height: 480, frameRate: 24 }`. No `aspectRatio`, no `resizeMode`.
- MediaPipe assets are self-hosted under `/mediapipe/`, never loaded from a CDN:
  - the model at `/mediapipe/blaze_face_short_range.tflite`;
  - the wasm files at `/mediapipe/wasm/`.
- Detector settings: `runningMode: 'VIDEO'`, `delegate: 'GPU'`, one retry with `'CPU'`. No
  `minDetectionConfidence` override.
- No UI and no banner. Every failure degrades silently to the centred crop, with at most one
  `console.warn` per failure.
- Commit messages are imperative and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A camera that ignores 640×480** (720p-only webcam, portrait phone 480×640). Framing must use the
   video's real size and stay inside it. Task 4, test `step builds framing from the real video size`.
2. **Video not ready** (`videoWidth === 0` before metadata). Nothing is drawn or detected, and nothing
   ends up `NaN`. Task 4, test `step skips frames before the video has a size`.
3. **Detector throws mid-session** (GPU context lost). The crop eases back to centre and detection is
   never retried. Task 4, test `a detector that throws is dropped and the crop returns to centre`.
4. **Model or wasm unreachable** (offline, blocked, nginx SPA fallback). `loadFaceDetector` resolves
   `null` with one warning. Task 3, test `a failed load resolves null`, plus the nginx `=404` location.
5. **Tab already hidden when the call starts** (the user switched tabs during the camera prompt). The
   first mesh must send the raw track. Task 5, test `a new mesh starts with the framer's send track`.

---

### Task 1: Framing model

**Files:**
- Create: `apps/web/src/media/framing.ts`
- Test: `apps/web/src/media/framing.test.ts`

**Interfaces:**
- Produces:
  - `export interface Box { x: number; y: number; w: number; h: number }`
  - `export interface Rect { x: number; y: number; size: number }`
  - `export interface Framing { update(face: Box | null, now: number): Rect }`
  - `export function createFraming(frameW: number, frameH: number): Framing`
  - the seven framing constants, exported.

- [ ] **Step 1: Write the failing tests** (`framing.test.ts`, 640×480 frame)

```ts
import { expect, test } from 'vitest';
import { type Box, createFraming, type Framing } from './framing';

const W = 640;
const H = 480;
const CENTRE = { x: 80, y: 0, size: 480 };
const face: Box = { x: 280, y: 200, w: 80, h: 100 }; // centre (320, 250) → side 176, headroom 17.6
const framed = { x: 232, y: 144.4, size: 176 };

/** Feeds `box` every 100 ms (as detections would) from `from` for `ms`; returns a copy of the last rect. */
function settle(f: Framing, box: Box | null, from: number, ms: number) {
  let r = f.update(box, from);
  for (let t = from + 100; t <= from + ms; t += 100) {
    r = f.update(box, t);
  }
  return { ...r };
}
const close = (r: { x: number; y: number; size: number }, e: typeof r) => {
  expect(r.x).toBeCloseTo(e.x, 1);
  expect(r.y).toBeCloseTo(e.y, 1);
  expect(r.size).toBeCloseTo(e.size, 1);
};

test('starts at the centred square', () => {
  expect(createFraming(W, H).update(null, 0)).toEqual(CENTRE);
});

test('settles on a square 2.2× the face width, raised by 10% headroom', () => {
  close(settle(createFraming(W, H), face, 0, 3000), framed);
});

test('the square is clamped inside the frame, never padded', () => {
  close(settle(createFraming(W, H), { x: 0, y: 200, w: 80, h: 100 }, 0, 3000), { x: 0, y: 144.4, size: 176 });
  close(settle(createFraming(W, H), { x: 560, y: 200, w: 80, h: 100 }, 0, 3000), { x: 464, y: 144.4, size: 176 });
  close(settle(createFraming(W, H), { x: 280, y: 0, w: 80, h: 60 }, 0, 3000), { x: 232, y: 0, size: 176 });
  close(settle(createFraming(W, H), { x: 280, y: 420, w: 80, h: 60 }, 0, 3000), { x: 232, y: 304, size: 176 });
});

test('zoom is limited to [160, min(w, h)]', () => {
  expect(settle(createFraming(W, H), { x: 300, y: 220, w: 40, h: 50 }, 0, 3000).size).toBeCloseTo(160, 1);
  expect(settle(createFraming(W, H), { x: 170, y: 100, w: 300, h: 360 }, 0, 3000).size).toBeCloseTo(480, 1);
});

test('small detector jitter inside the dead zone does not move the crop', () => {
  const f = createFraming(W, H);
  const before = settle(f, face, 0, 3000);
  close(settle(f, { ...face, x: face.x + 5, w: face.w + 4 }, 3100, 1000), before);
});

test('a real move outside the dead zone is followed', () => {
  const f = createFraming(W, H);
  settle(f, face, 0, 3000);
  close(settle(f, { ...face, x: face.x + 40 }, 3100, 3000), { ...framed, x: framed.x + 40 });
});

test('easing is time-based: one 300 ms step equals ten 30 ms steps', () => {
  const a = createFraming(W, H);
  a.update(face, 0);
  const one = { ...a.update(null, 300) };
  const b = createFraming(W, H);
  b.update(face, 0);
  let ten = b.update(null, 30);
  for (let t = 60; t <= 300; t += 30) {
    ten = b.update(null, t);
  }
  close(ten, one);
});

test('a lost face eases back to centre after 1.5 s, and a returning face is tracked again', () => {
  const f = createFraming(W, H);
  settle(f, face, 0, 3000);
  close(settle(f, null, 3100, 1300), framed); // still within LOST_MS of the last box at 3000
  close(settle(f, null, 4600, 5000), CENTRE);
  close(settle(f, face, 9700, 3000), framed);
});

test('update reuses one rect object', () => {
  const f = createFraming(W, H);
  expect(f.update(face, 0)).toBe(f.update(null, 16));
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/src/media/framing.test.ts`
Expected: FAIL. The suite cannot resolve `./framing`.

- [ ] **Step 3: Implement `createFraming(frameW, frameH): Framing` in `framing.ts`**

How it works:
- State: `target` and `current` rects, `lastBoxAt`, `lastNow`.
- The target from a box is `side = clamp(FACE_SCALE × w, MIN_SIDE, min(W, H))`, centred at
  `(x + w/2, y + h/2 − HEADROOM × side)`, then shifted inside the frame.
- Replace the target only when the clamped candidate leaves the dead zone. The dead zone is measured
  against the old target: centre distance `> DEAD_MOVE × side`, or `|Δside| > DEAD_SIZE × side`.
- With no box for `> LOST_MS` since `lastBoxAt`, the target is the centred square.
- Ease `current` toward `target` with `k = 1 − exp(−(now − lastNow) / EASE_MS)`. The first call has
  `dt = 0`.
- Write into `current` and return it.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm exec vitest run apps/web/src/media/framing.test.ts`
Expected: all tests in the file PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/media/framing.ts apps/web/src/media/framing.test.ts
git commit -m "Add the face framing model"
```

---

### Task 2: Mesh can swap the outgoing video track

**Files:**
- Modify: `apps/web/src/media/mesh.ts`: `MediaTransport` interface, `localTrack`, `createMesh` return
  value.
- Modify: `apps/web/src/media/fake-rtc.ts`: `addTransceiver`, `getTransceivers`.
- Modify: `apps/web/src/media/call.test.ts`: the fake mesh in `makeCall` gets `setVideoTrack: vi.fn()`.
- Test: `apps/web/src/media/mesh.test.ts`

**Interfaces:**
- Produces: `MediaTransport.setVideoTrack(track: MediaStreamTrack): void`. It replaces the track on
  every video sender that currently has a track. Later connections send the chosen track.

- [ ] **Step 1: Make the fake record initiator transceivers**

In `FakeRTCPeerConnection.addTransceiver`, besides pushing `{ trackOrKind, init }`, create a
`FakeTransceiver`. Its kind is the track's `kind`, or the string when given a kind. Set
`sender.track` to the track when one was passed, and `direction` from `init`. Keep the transceivers
in a `localTransceivers` array. `getTransceivers()` returns
`[...this.localTransceivers, ...this.remoteTransceivers]`.

- [ ] **Step 2: Run the existing mesh tests**

Run: `pnpm exec vitest run apps/web/src/media/mesh.test.ts`
Expected: PASS. The fake change alone must not break anything.

- [ ] **Step 3: Write the failing tests** (append to `mesh.test.ts`)

```ts
const rawTrack = { kind: 'video', id: 'raw' } as unknown as MediaStreamTrack;

test('setVideoTrack swaps the video sender of existing connections, not audio', async () => {
  const init = mesh('b');
  init.connect('a');
  init.setVideoTrack(rawTrack);
  await tick();
  expect(pc(0).getTransceivers()[0]?.sender.track).toBe(rawTrack);

  const ans = mesh('a');
  await ans.handleSignal('b', offer);
  ans.setVideoTrack(rawTrack);
  await tick();
  const [video, audio] = pc(1).remoteTransceivers;
  expect(video?.sender.track).toBe(rawTrack);
  expect(audio?.sender.track).toBe(audioTrack);
});

test('connections made after setVideoTrack send the chosen track', async () => {
  const init = mesh('b');
  init.setVideoTrack(rawTrack);
  init.connect('a');
  expect(pc(0).transceivers[0]?.trackOrKind).toBe(rawTrack);

  const ans = mesh('a');
  ans.setVideoTrack(rawTrack);
  await ans.handleSignal('b', offer);
  expect(pc(1).remoteTransceivers[0]?.sender.track).toBe(rawTrack);
});

test('setVideoTrack does not start sending on a receive-only connection', async () => {
  const m = mesh('b', null);
  m.connect('a');
  m.setVideoTrack(rawTrack);
  await tick();
  expect(pc().getTransceivers()[0]?.sender.track).toBeNull();
});
```

- [ ] **Step 4: Run the tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/src/media/mesh.test.ts`
Expected: FAIL with `setVideoTrack is not a function`.

- [ ] **Step 5: Implement `setVideoTrack` in `mesh.ts`**

- Add `let videoOverride: MediaStreamTrack | null = null`.
- `localTrack('video')` returns `videoOverride ?? local?.getVideoTracks()[0] ?? null`.
- `setVideoTrack(track)`:
  - store `track`;
  - when `local` is non-null, for every conn and every transceiver with
    `receiver.track.kind === 'video' && sender.track`, call `void t.sender.replaceTrack(track)` with
    a `.catch` that `console.warn`s.
- Add the method to the `MediaTransport` interface.
- Add `setVideoTrack: vi.fn()` to the fake mesh in `call.test.ts`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm exec vitest run apps/web/src/media/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/media/mesh.ts apps/web/src/media/mesh.test.ts apps/web/src/media/fake-rtc.ts apps/web/src/media/call.test.ts
git commit -m "Let the mesh swap the outgoing video track"
```

---

### Task 3: Self-hosted MediaPipe face detector

**Files:**
- Modify: `apps/web/package.json`: add `"@mediapipe/tasks-vision": "1.1.0"` to `dependencies` (exact
  version).
- Create: `apps/web/public/mediapipe/blaze_face_short_range.tflite`, downloaded from
  `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite`.
- Create: `apps/web/mediapipe-wasm.ts`, the Vite plugin.
- Modify: `apps/web/vite.config.ts` (register the plugin) and `apps/web/tsconfig.json` (add
  `"mediapipe-wasm.ts"` to `include`).
- Modify: `apps/web/nginx/default.conf.template`: the `/mediapipe/` location.
- Create: `apps/web/src/media/face-detector.ts`
- Test: `apps/web/src/media/face-detector.test.ts`

**Interfaces:**
- Consumes: `Box` from Task 1.
- Produces:
  - `export interface Detector { detect(video: HTMLVideoElement, now: number): Box | null }`
  - `export function largestBox(detections: { boundingBox?: { originX: number; originY: number; width: number; height: number } }[]): Box | null`
  - `export function loadFaceDetector(deps?: { load?: () => Promise<typeof import('@mediapipe/tasks-vision')> }): Promise<Detector | null>`
    - `load` defaults to `() => import('@mediapipe/tasks-vision')`, a dynamic import, so the library is
      code-split out of the main bundle.

- [ ] **Step 1: Install the dependency and add the model**

Run: `pnpm --filter @zoom3d/web add @mediapipe/tasks-vision@1.1.0 --save-exact`, then
`curl -fL -o apps/web/public/mediapipe/blaze_face_short_range.tflite <URL above>`.
Expected: the lockfile is updated and the `.tflite` file is about 230 KB.

- [ ] **Step 2: Write the failing tests** (`face-detector.test.ts`)

```ts
import { expect, test, vi } from 'vitest';
import { largestBox, loadFaceDetector } from './face-detector';

const det = (originX: number, originY: number, width: number, height: number) => ({
  boundingBox: { originX, originY, width, height },
});

test('largestBox picks the biggest face and maps it to a Box', () => {
  expect(largestBox([det(0, 0, 20, 20), det(100, 50, 80, 90), det(300, 0, 40, 40)])).toEqual({
    x: 100, y: 50, w: 80, h: 90,
  });
});

test('largestBox is null with no usable detections', () => {
  expect(largestBox([])).toBeNull();
  expect(largestBox([{}])).toBeNull();
});

test('a failed load resolves null with one warning', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await loadFaceDetector({ load: () => Promise.reject(new Error('404')) })).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test('GPU init failure retries once on CPU', async () => {
  const delegates: string[] = [];
  const detector = { detectForVideo: () => ({ detections: [det(1, 2, 3, 4)] }) };
  const load = async () =>
    ({
      FilesetResolver: { forVisionTasks: async (path: string) => ({ path }) },
      FaceDetector: {
        createFromOptions: async (_: unknown, o: { baseOptions: { delegate: string } }) => {
          delegates.push(o.baseOptions.delegate);
          if (o.baseOptions.delegate === 'GPU') {
            throw new Error('no webgl');
          }
          return detector;
        },
      },
    }) as never;
  const d = await loadFaceDetector({ load });
  expect(delegates).toEqual(['GPU', 'CPU']);
  expect(d?.detect({} as HTMLVideoElement, 0)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/src/media/face-detector.test.ts`
Expected: FAIL. The suite cannot resolve `./face-detector`.

- [ ] **Step 4: Implement `face-detector.ts`**

- Call `FilesetResolver.forVisionTasks('/mediapipe/wasm')`.
- Call `FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: '/mediapipe/blaze_face_short_range.tflite', delegate }, runningMode: 'VIDEO' })`
  with `delegate` `'GPU'`, then `'CPU'` on throw.
- Any other failure: one `console.warn('face detector unavailable', err)` and return `null`.
- `detect(video, now)` returns `largestBox(detector.detectForVideo(video, now).detections)`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm exec vitest run apps/web/src/media/face-detector.test.ts`
Expected: PASS.

- [ ] **Step 6: Serve the wasm files with a Vite plugin (`apps/web/mediapipe-wasm.ts`)**

`export function mediapipeWasm(): Plugin` serves and emits these four files from
`node_modules/@mediapipe/tasks-vision/wasm/`, resolved with `createRequire(import.meta.url)`:
`vision_wasm_internal.{js,wasm}` and `vision_wasm_nosimd_internal.{js,wasm}`.

- In `configureServer`, add middleware that answers `/mediapipe/wasm/<name>` for those names, with
  `application/wasm` or `text/javascript`.
- In `generateBundle`, call `this.emitFile({ type: 'asset', fileName: 'mediapipe/wasm/<name>', source })`.

Then:
- Register `plugins: [mediapipeWasm()]` in `vite.config.ts`.
- Add the nginx location above `location /`:

```nginx
    # Self-hosted MediaPipe model + wasm (face framing). A missing file must 404, not fall back to index.html.
    location /mediapipe/ {
        add_header Cache-Control "public, max-age=86400";
        try_files $uri =404;
    }
```

- [ ] **Step 7: Verify the files are served and built**

Run `pnpm --filter @zoom3d/web build && ls -la apps/web/dist/mediapipe apps/web/dist/mediapipe/wasm`.
Expected: the `.tflite` file plus the four wasm/js files.

Then, with `pnpm dev` running, run
`curl -sI http://localhost:5173/mediapipe/wasm/vision_wasm_internal.wasm | head -3`.
Expected: `200` with `content-type: application/wasm`.

Finally run `pnpm typecheck && pnpm lint`. Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/public apps/web/mediapipe-wasm.ts apps/web/vite.config.ts apps/web/tsconfig.json apps/web/nginx/default.conf.template apps/web/src/media/face-detector.ts apps/web/src/media/face-detector.test.ts
git commit -m "Self-host the MediaPipe face detector"
```

---

### Task 4: Framer (frame step + canvas track)

**Files:**
- Create: `apps/web/src/media/framer.ts`
- Modify: `apps/web/index.html`: add `<div id="local-media" aria-hidden="true"></div>`. Extend the
  `#media` CSS rule's selector to `#media, #local-media`, keeping the `visibility: hidden` comment.
- Test: `apps/web/src/media/framer.test.ts` (frame step only; the glue is verified in Task 6)

**Interfaces:**
- Consumes:
  - `createFraming`, `Rect`, `Box` from Task 1;
  - `Detector`, `loadFaceDetector` from Task 3.
- Produces:
  - `export function createFrameStep(draw: (video: HTMLVideoElement, rect: Rect) => void): { setDetector(d: Detector | null): void; step(video: HTMLVideoElement, now: number): void }`
  - `export interface Framer { readonly track: MediaStreamTrack; readonly rawTrack: MediaStreamTrack; readonly sendTrack: MediaStreamTrack; onSendTrackChange: (() => void) | null; setEnabled(on: boolean): void }`
  - `export function createFramer(opts: { rawTrack: MediaStreamTrack; container: HTMLElement; document: Document; loadDetector?: () => Promise<Detector | null> }): Framer`
  - `OUTPUT_SIZE = 256`, `OUTPUT_FPS = 24`, `DETECT_MS = 200`.

- [ ] **Step 1: Write the failing tests** (`framer.test.ts`)

```ts
import { expect, test, vi } from 'vitest';
import type { Detector } from './face-detector';
import { createFrameStep } from './framer';
import type { Rect } from './framing';

const video = (w = 640, h = 480) => ({ videoWidth: w, videoHeight: h }) as HTMLVideoElement;
const face = { x: 280, y: 200, w: 80, h: 100 };
function harness() {
  const rects: Rect[] = [];
  const s = createFrameStep((_, r) => rects.push({ ...r }));
  return { s, rects };
}

test('without a detector every frame draws the centred square', () => {
  const { s, rects } = harness();
  s.step(video(), 0);
  s.step(video(), 40);
  expect(rects).toEqual([
    { x: 80, y: 0, size: 480 },
    { x: 80, y: 0, size: 480 },
  ]);
});

test('detection runs at most every 200 ms and gets the video and time', () => {
  const { s } = harness();
  const detect = vi.fn<Detector['detect']>(() => face);
  s.setDetector({ detect });
  const v = video();
  for (const t of [0, 50, 100, 150, 200, 250, 399, 400]) {
    s.step(v, t);
  }
  expect(detect.mock.calls).toEqual([
    [v, 0],
    [v, 200],
    [v, 400],
  ]);
});

test('a detector that throws is dropped and the crop returns to centre', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { s, rects } = harness();
  const detect = vi.fn<Detector['detect']>(() => face);
  s.setDetector({ detect });
  for (let t = 0; t <= 2000; t += 40) {
    s.step(video(), t);
  }
  detect.mockImplementation(() => {
    throw new Error('context lost');
  });
  for (let t = 2040; t <= 9000; t += 40) {
    s.step(video(), t);
  }
  expect(detect).toHaveBeenCalledTimes(12); // 11 good detections (0..2000), then one that throws
  expect(warn).toHaveBeenCalledTimes(1);
  const last = rects.at(-1) as Rect;
  expect(last.size).toBeCloseTo(480, 1);
  expect(last.x).toBeCloseTo(80, 1);
  warn.mockRestore();
});

test('step builds framing from the real video size', () => {
  const { s, rects } = harness();
  s.step(video(480, 640), 0);
  expect(rects.at(-1)).toEqual({ x: 0, y: 80, size: 480 });
  s.step(video(1280, 720), 40);
  expect(rects.at(-1)).toEqual({ x: 280, y: 0, size: 720 });
});

test('step skips frames before the video has a size', () => {
  const { s, rects } = harness();
  const detect = vi.fn<Detector['detect']>(() => face);
  s.setDetector({ detect });
  s.step(video(0, 0), 0);
  expect(rects).toEqual([]);
  expect(detect).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/src/media/framer.test.ts`
Expected: FAIL. The suite cannot resolve `./framer`.

- [ ] **Step 3: Implement `createFrameStep` in `framer.ts`**

Behaviour:
- Return early when `videoWidth === 0`.
- Create the framing on the first sized frame, and re-create it when `videoWidth`/`videoHeight` change.
- Detection runs when `now − lastDetectAt >= DETECT_MS` (the first sized frame always detects).
- A throw from `detect` sets the detector to `null`, with one `console.warn`.
- Pass the detection result on detection frames and `null` otherwise.
- Call `draw(video, framing.update(box, now))`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm exec vitest run apps/web/src/media/framer.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `createFramer` in `framer.ts` (glue, no unit test)**

- **Hidden video:** `document.createElement('video')`, with `muted`, `playsInline`, `autoplay` and
  `srcObject = new MediaStream([rawTrack])`, appended to `container`, then `void video.play()`.
- **Canvas:** `OUTPUT_SIZE`², 2D context. `draw` does
  `ctx.drawImage(video, r.x, r.y, r.size, r.size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)`.
- **Track:** `track = canvas.captureStream(OUTPUT_FPS).getVideoTracks()[0]`.
- **Draw loop:**
  - If `video.requestVideoFrameCallback` exists, each callback runs `step.step(video, now)` (skipped
    while disabled) and re-arms.
  - Otherwise `setInterval(…, 42)` steps with `performance.now()`.
- **Detector:** `(opts.loadDetector ?? loadFaceDetector)().then((d) => step.setDetector(d))`. Never
  awaited.
- **`sendTrack`:** a getter, `document.visibilityState === 'hidden' ? rawTrack : track`.
- **Visibility:** a `visibilitychange` listener calls `framer.onSendTrackChange?.()`.
- **`setEnabled(on)`:** sets `rawTrack.enabled` and `track.enabled`, plus the flag that makes the loop
  skip steps.

- [ ] **Step 6: Typecheck, lint and run the tests**

Run: `pnpm typecheck && pnpm lint && pnpm exec vitest run apps/web/src/media/`
Expected: clean, and PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/media/framer.ts apps/web/src/media/framer.test.ts apps/web/index.html
git commit -m "Add the framer: detect, frame and draw the camera to a 256² track"
```

---

### Task 5: Wire framing into capture, call and main

**Files:**
- Modify: `apps/web/src/media/capture.ts`: `VIDEO_CONSTRAINTS`, `CaptureEnv`, `LocalMedia`,
  `captureLocalMedia`.
- Modify: `apps/web/src/media/call.ts`: `welcome` (after `createMesh`) and `setCam`.
- Modify: `apps/web/src/main.ts`: the `captureLocalMedia` call in `joinRoom`.
- Modify: `AGENTS.md`: a new gotcha.
- Test: `apps/web/src/media/capture.test.ts`, `apps/web/src/media/call.test.ts`

**Interfaces:**
- Consumes:
  - `Framer`, `createFramer` from Task 4;
  - `MediaTransport.setVideoTrack` from Task 2.
- Produces:
  - `LocalMedia.framer: Framer | null`;
  - `CaptureEnv.frame?: (raw: MediaStreamTrack) => Framer`;
  - `CaptureEnv.createStream?: (tracks: MediaStreamTrack[]) => MediaStream` (defaults to
    `new MediaStream(tracks)`; injected in tests).

- [ ] **Step 1: Write the failing tests**

In `capture.test.ts`:
- Change the constraints expectation to `{ width: 640, height: 480, frameRate: 24 }`.
- Add `framer: null` to the two `toEqual` results (`none-available`, `insecure`).
- Make the fake tracks distinct objects: `video: { kind: 'video', id: 'raw' }` and
  `audio: { kind: 'audio', id: 'mic' }`.
- Add:

```ts
const fakeFramer = (raw: unknown) => ({ track: { kind: 'video', id: 'framed' }, rawTrack: raw }) as unknown as Framer;

test('a camera is framed: the stream carries the framed track and the original audio', async () => {
  const { getUserMedia } = fakeGetUserMedia({ video: true, audio: true });
  const frame = vi.fn(fakeFramer);
  const local = await captureLocalMedia({
    isSecureContext: true,
    getUserMedia,
    frame,
    createStream: (tracks) => ({ tracks }) as unknown as MediaStream,
  });
  expect(frame).toHaveBeenCalledWith({ kind: 'video', id: 'raw' });
  expect(local.framer).toBe(frame.mock.results[0]?.value);
  expect((local.stream as unknown as { tracks: unknown[] }).tracks).toEqual([
    { kind: 'video', id: 'framed' },
    { kind: 'audio', id: 'mic' },
  ]);
});

test('no camera, no framer', async () => {
  const { getUserMedia } = fakeGetUserMedia({ video: false, audio: true });
  const frame = vi.fn(fakeFramer);
  const local = await captureLocalMedia({ isSecureContext: true, getUserMedia, frame });
  expect(frame).not.toHaveBeenCalled();
  expect(local.framer).toBeNull();
});
```

In `call.test.ts`:
- `makeCall`'s default `local` gains `framer: null`.
- Add:

```ts
function fakeFramer(sendTrack: unknown) {
  return { sendTrack, setEnabled: vi.fn(), onSendTrackChange: null as (() => void) | null };
}

test("a new mesh starts with the framer's send track", () => {
  const framer = fakeFramer({ id: 'raw' });
  const call = makeCall({ framer: framer as never });
  call.listener.welcome?.('me', ICE, true);
  expect(meshes[0]?.setVideoTrack).toHaveBeenCalledWith({ id: 'raw' });
});

test('a send-track change reaches the current mesh', () => {
  const framer = fakeFramer({ id: 'framed' });
  const call = makeCall({ framer: framer as never });
  call.listener.welcome?.('me', ICE, true);
  framer.sendTrack = { id: 'raw' };
  framer.onSendTrackChange?.();
  expect(meshes[0]?.setVideoTrack).toHaveBeenLastCalledWith({ id: 'raw' });
});

test('turning the camera off disables the framer', () => {
  const framer = fakeFramer({ id: 'framed' });
  const call = makeCall({ framer: framer as never });
  call.setCam(false);
  expect(framer.setEnabled).toHaveBeenLastCalledWith(false);
  call.setCam(true);
  expect(framer.setEnabled).toHaveBeenLastCalledWith(true);
});

test('without a framer the mesh keeps the stream track', () => {
  const call = makeCall();
  call.listener.welcome?.('me', ICE, true);
  expect(meshes[0]?.setVideoTrack).not.toHaveBeenCalled();
});
```

(Add `setVideoTrack: ReturnType<typeof vi.fn>` to the `meshes` element type.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/src/media/capture.test.ts apps/web/src/media/call.test.ts`
Expected: FAIL. Constraints mismatch, `framer` is undefined, and `setVideoTrack` is never called.

- [ ] **Step 3: Implement**

- **`capture.ts`:**
  - Update the constraints. Every return path includes `framer`.
  - When `env.frame` is given and the stream has a video track:
    - `framer = env.frame(video)`;
    - `stream = (env.createStream ?? ((t) => new MediaStream(t)))([framer.track, ...stream.getAudioTracks()])`.
- **`call.ts`:**
  - In `welcome`, right after `mesh = opts.createMesh(...)`:
    `if (local.framer) { mesh.setVideoTrack(local.framer.sendTrack); }`.
  - Once in `createCall`, if `local.framer` exists, set
    `local.framer.onSendTrackChange = () => { if (local.framer) { mesh?.setVideoTrack(local.framer.sendTrack); } }`.
  - In `setCam`, call `local.framer?.setEnabled(state.cam)`.
- **`main.ts`:** pass
  `frame: (raw) => createFramer({ rawTrack: raw, container: document.getElementById('local-media') as HTMLDivElement, document })`.
- **`AGENTS.md` gotchas:** add one line: "Face framing: the sent video is a canvas track drawn on
  `requestVideoFrameCallback`, which stops in hidden tabs. `framer.sendTrack` flips to the raw camera
  track while hidden, and the call pushes it to the mesh. Don't remove that swap, or peers freeze on
  tab switch."

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/media/capture.ts apps/web/src/media/capture.test.ts apps/web/src/media/call.ts apps/web/src/media/call.test.ts apps/web/src/main.ts AGENTS.md
git commit -m "Send the framed camera track, swapping to raw while the tab is hidden"
```

---

### Task 6: End-to-end checks and manual verification

**Files:**
- Create: `apps/web/e2e/framing.spec.ts`

**Interfaces:**
- Consumes:
  - `createAndJoin`, `joinAs` from `apps/web/e2e/join.ts`;
  - the room bar's `Cam on` button, as in `faces.spec.ts`.

- [ ] **Step 1: Write the specs**

```ts
import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

const remoteSize = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('#media video');
    return v ? [v.videoWidth, v.videoHeight] : null;
  });
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

test('peers receive the framed 256² video; a hidden tab sends the raw frame until visible', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');
  await expect.poll(() => remoteSize(b), { timeout: 15_000 }).toEqual([256, 256]);
  await setHidden(a, true);
  await expect.poll(() => remoteSize(b), { timeout: 10_000 }).toEqual([640, 480]);
  await setHidden(a, false);
  await expect.poll(() => remoteSize(b), { timeout: 10_000 }).toEqual([256, 256]);
});

test('turning the camera off disables the raw camera track', async ({ page }) => {
  await createAndJoin(page, 'Ada');
  const rawEnabled = () =>
    page.evaluate(
      () => (document.querySelector<HTMLVideoElement>('#local-media video')?.srcObject as MediaStream | null)
        ?.getVideoTracks()[0]?.enabled ?? null
    );
  await expect.poll(rawEnabled).toBe(true);
  await page.getByRole('button', { name: 'Cam on' }).click();
  await expect.poll(rawEnabled).toBe(false);
});
```

- [ ] **Step 2: Run the new specs**

Run: `pnpm e2e -- framing.spec.ts`
Expected: 2 passed. If the first `[256, 256]` poll sees `[640, 480]`, page `a` is hidden from
Playwright's point of view. Call `await a.bringToFront()` before polling, and say so in the spec's
comment.

- [ ] **Step 3: Run the full e2e suite**

Run: `pnpm e2e`
Expected: all pass, including `frame-rate.spec.ts` (median frame interval under 20 ms) and
`faces.spec.ts`.

- [ ] **Step 4: Manual check with a real camera** (`pnpm dev`, two browser windows)

Confirm each of these:
- Lean left, lean right and sit back. The peer's disc stays centred at a steady size, and doesn't
  wobble while you're still.
- Switch tabs. The peer keeps seeing you live (centre crop).
- Toggle the camera off. The camera light goes off.
- In DevTools, block `/mediapipe/wasm/*` and reload. You get a centre crop with one warning.

Write down anything that looked off. Tuning the constants is a spec change.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/framing.spec.ts
git commit -m "Cover face framing end to end"
```
