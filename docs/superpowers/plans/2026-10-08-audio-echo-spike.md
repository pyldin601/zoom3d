# Audio Echo Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer risk R1: does browser echo cancellation still work when remote WebRTC audio
is played through the spec §9.1 Web Audio graph (laptop speakers vs headphones, Chrome and
Firefox)? Also get a first by-ear impression of the distance, pan, reverb and muffle curves.

**Architecture:** A throwaway mini-app in `spikes/audio-echo/`. A Node HTTPS server serves a
static page and a 2-client WebSocket relay for signaling. The page captures the mic, connects
one `RTCPeerConnection` to the other client, and plays remote audio in one of three
switchable output modes. A 2D pad positions the remote source relative to the listener. Plain
ES modules, no build step. Not part of the future monorepo, and nothing here is reused.

**Tech Stack:** Node 22 (built-in `node:test`, `node:https`), `ws`, browser WebRTC + Web Audio, `openssl` for a self-signed cert.

**Spec:** [docs/superpowers/specs/2026-10-08-zoom3d-design.md](../specs/2026-10-08-zoom3d-design.md) (§9 Spatial audio, §9.4 Known risk R1, §12 step 0)

## Global Constraints

- Everything lives under `spikes/audio-echo/`. Nothing is imported from or into `apps/` or `packages/`.
- Capture constraints are exactly: `{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }`, audio only.
- Curve constants are from spec §9.2: `REF = 1.5`, `MAX = 12` tiles; `dry(d) = (1-n)^2`;
  `send(d) = (0.15 + 0.35·n)·(1 - n^4)`; occluded: lowpass 16000 → 700 Hz, gains × 0.5.
  Smoothing: `setTargetAtTime` with τ 0.05 s (position) and τ 0.15 s (occlusion).
- PannerNode: `distanceModel: 'linear'`, `rolloffFactor: 0`, `panningModel` toggle `HRTF` / `equalpower`.
- Impulse response: synthesized stereo decaying noise, RT ≈ 0.8 s, ~10 ms pre-delay.
- HTTPS is required (getUserMedia on LAN). The cert and key are generated locally and gitignored.
- Code is throwaway: the minimum to answer the question. Unit tests only where logic is non-trivial (the relay).

## Review Focus

1. **A third tab joins** → the relay must reject it (close with a reason) rather than corrupt the 2-peer session. Test in Task 1.
2. **A peer leaves and rejoins** → the remaining client must be told (`peer-left`) and the new one must connect fresh, without a page reload of the survivor. Test in Task 1 (relay message); manual check in Task 3.
3. **AudioContext created before a gesture** → silent output. The Start button must create and resume the context. Manual check in Task 4.
4. **Chrome's remote-stream quirk** → in Web Audio modes the remote stream must also be attached to a muted, playing `<audio>` element, or there is silence. Manual check in Task 4.
5. **Switching output mode mid-call** → no double playback (the old path must be fully disconnected or muted). Manual check in Task 4.

---

### Task 1: Spike scaffold and signaling relay

**Files:**
- Create: `spikes/audio-echo/package.json` (`"type": "module"`, dependency `ws@8`, scripts `test: node --test`, `cert: sh gen-cert.sh`, `start: node server.mjs`)
- Create: `spikes/audio-echo/relay.mjs`
- Create: `spikes/audio-echo/.gitignore` (`node_modules/`, `.cert/`)
- Test: `spikes/audio-echo/relay.test.mjs`

**Interfaces:**
- Produces: `createRelay(): { add(socket): void, size(): number }`. Here `socket` is any object
  with `send(string)`, `close(code, reason)` and `on(event, handler)` for `'message'` and
  `'close'`, matching the `ws` WebSocket API.
- Relay protocol (JSON strings):
  - Sent by the relay: `{type:'role', role:'wait'}` to the first client; `{type:'role', role:'offer'}` to the second client; `{type:'peer-joined'}` to the first when the second arrives; `{type:'peer-left'}` to the survivor.
  - Any other message from one client is forwarded verbatim to the other client.
  - A third client is closed with code `4000` and reason `'full'`.

- [ ] **Step 1: Write the failing tests** using a `FakeSocket` class in the test file (records `sent[]`, `closed`, and lets the test `emit('message', data)` and `emit('close')`):
  - `first client gets role wait` → `sent` deep-equals `['{"type":"role","role":"wait"}']`
  - `second client gets role offer and first gets peer-joined`
  - `messages are forwarded only to the other client` → A emits `'{"x":1}'`; B.sent ends with `'{"x":1}'`; A.sent has no `'{"x":1}'`
  - `third client is closed with 4000 full` and `size()` stays 2
  - `when a client closes, the survivor gets peer-left and size() is 1`
  - `a client joining after a leave gets role offer`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd spikes/audio-echo && npm install && npm test`
Expected: FAIL (cannot find `./relay.mjs`)

- [ ] **Step 3: Implement `createRelay()` in `relay.mjs`** with an array of at most 2 sockets. The role is `'wait'` if the socket is the only one after adding, else `'offer'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add spikes/audio-echo
git commit -m "spike(audio): add 2-peer signaling relay"
```

### Task 2: HTTPS static server

**Files:**
- Create: `spikes/audio-echo/gen-cert.sh`: `openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=zoom3d-spike" -keyout .cert/key.pem -out .cert/cert.pem` (after `mkdir -p .cert`)
- Create: `spikes/audio-echo/server.mjs`
- Create: `spikes/audio-echo/public/index.html` (placeholder `<h1>audio-echo spike</h1>`, replaced in Task 3)

**Interfaces:**
- Consumes: `createRelay()` from Task 1.
- Produces: `https://<host>:8443/` serving `public/*` (content types for `.html`, `.js`,
  `.css`; reject `..` paths with 404), and a WebSocket at path `/ws` wired to one relay instance.
  On start it logs every non-internal IPv4 URL (`os.networkInterfaces()`).
  The port comes from env var `PORT`, default `8443`. It binds `0.0.0.0`.

- [ ] **Step 1: Generate the cert and start the server**

Run: `npm run cert && npm start` (background)
Expected: log lines like `https://192.168.x.x:8443/`

- [ ] **Step 2: Verify static serving and path safety**

Run: `curl -sk https://localhost:8443/ | grep -c "audio-echo spike"` → `1`
Run: `curl -sk --path-as-is -o /dev/null -w "%{http_code}" https://localhost:8443/../server.mjs` → `404`

- [ ] **Step 3: Commit**

```bash
git add spikes/audio-echo
git commit -m "spike(audio): https static server with ws relay"
```

### Task 3: Page with mic capture and WebRTC connection (baseline playback)

**Files:**
- Modify: `spikes/audio-echo/public/index.html`
- Create: `spikes/audio-echo/public/client.js`

**Interfaces:**
- Consumes: the relay protocol from Task 1, at `wss://${location.host}/ws`.
- Produces (for Task 4): `client.js` exposes the remote `MediaStream` through a callback
  `onRemoteStream(stream)`, which the audio module will consume. The connection state is
  shown in `#status`.

Page elements: a **Start** button (`#start`), `#status` text, a hidden-but-present
`<audio id="remote" autoplay playsinline>`, and a log `<pre id="log">`.

- [ ] **Step 1: Implement the connection flow in `client.js`**
  - On Start, call `getUserMedia({audio: {echoCancellation:true, noiseSuppression:true, autoGainControl:true}})`, then open the WebSocket.
  - Create an `RTCPeerConnection` with `{iceServers:[{urls:'stun:stun.l.google.com:19302'}]}` and add the mic track.
  - Role `offer` creates and sends the offer; role `wait` waits for `peer-joined`, then the offer.
  - Messages are `{kind:'sdp', sdp}` and `{kind:'ice', candidate}`.
  - On `peer-left`, close and recreate the peer connection and go back to waiting.
  - In baseline mode, `ontrack` sets `#remote.srcObject = stream`.
  - Log the effective `track.getSettings()` (shows whether `echoCancellation` is really on).

- [ ] **Step 2: Manual check in two tabs on one machine**

Run: open `https://localhost:8443/` in two tabs and click Start in both.
Expected: both show `#status` = `connected` (pc.connectionState), and the log shows `echoCancellation: true`.

- [ ] **Step 3: Manual check of rejoin (Review Focus 2)**

Close tab B and reopen it, then click Start.
Expected: tab A logs `peer-left`, then reconnects without a reload.

- [ ] **Step 4: Commit**

```bash
git add spikes/audio-echo/public
git commit -m "spike(audio): mic capture and p2p connection with baseline playback"
```

### Task 4: Spatial graph, position pad and output modes

**Files:**
- Create: `spikes/audio-echo/public/audio.js`
- Create: `spikes/audio-echo/public/pad.js`
- Modify: `spikes/audio-echo/public/index.html`, `spikes/audio-echo/public/client.js`

**Interfaces:**
- Consumes: `onRemoteStream(stream)` from Task 3.
- Produces, in `audio.js`:
  - `createSpatial(ctx: AudioContext, stream: MediaStream): Spatial`, with `Spatial` =
    `{ setPosition(dx: number, dy: number): void, setOccluded(on: boolean): void,
      setPanningModel(m: 'HRTF'|'equalpower'): void, connectTo(mode: 'webaudio'|'webaudio-element'): void, dispose(): void }`
  - `curves(d: number): { dry: number, send: number }` with the spec §9.2 formulas
  - `makeImpulse(ctx: AudioContext, seconds = 0.8, preDelay = 0.01): AudioBuffer`
- Produces, in `pad.js`: `createPad(canvas: HTMLCanvasElement, onMove: (dx: number, dy: number) => void)`.
  The listener sits at the centre facing up. 1 tile = 20 px. The pad draws rings at REF and
  MAX and shows the current distance.

Controls added to the page:
- Output mode radio: `element` (baseline `<audio>`), `webaudio` (graph → `ctx.destination`), `webaudio-element` (graph → `MediaStreamAudioDestinationNode` → `<audio id="spatial">`)
- Panning model radio: `HRTF` / `equalpower`
- `occluded` checkbox
- A readout of the dry/send values

Rules:
- The `AudioContext` is created inside the Start click handler and `resume()`d there (Review Focus 3).
- In both Web Audio modes, `#remote` keeps `srcObject = stream` but has `muted = true`, and `play()` is called on it (Review Focus 4).
- Switching mode first silences the previous path: `#remote.muted` toggles, the graph output disconnects, and `#spatial` pauses (Review Focus 5).
- The listener stays at the origin facing −z (`forwardZ = -1`). The pad's `(dx, dy)` maps to panner `(dx, 0, dy)`.

- [ ] **Step 1: Implement `audio.js` and `pad.js`, and wire them into `client.js` and `index.html`**

- [ ] **Step 2: Manual check in two tabs with headphones**

Expected:
- Dragging the source left or right pans the voice.
- Moving it away makes it quieter and more reverberant, and silent beyond the MAX ring.
- `occluded` makes it muffled and quieter.
- Switching modes never doubles the voice.
- The readout shows dry = 1 inside REF and 0 at or beyond MAX.

- [ ] **Step 3: Commit**

```bash
git add spikes/audio-echo/public
git commit -m "spike(audio): spatial graph, position pad and output modes"
```

### Task 5: Echo test protocol, run and verdict

**Files:**
- Create: `spikes/audio-echo/README.md` (how to run, plus the test protocol below)
- Modify: `docs/open-decisions.md` (R1 verdict)

Test protocol: two devices on the same LAN. Device A is the **laptop on speakers, no
headphones**. Device B uses **headphones**. Person B talks. Echo means B hears their own
voice come back.

For each A-browser in {Chrome, Firefox} and each mode in {`element`, `webaudio`, `webaudio-element`}:
1. Place the source at about 2 tiles, 45° to the right.
2. B counts aloud from 1 to 10.
3. Record whether B hears echo: none / faint / clear.

Fill in this result table in the README:

| A browser | mode | echo heard by B |
|---|---|---|

- [ ] **Step 1: Write the README with the run steps and protocol**
- [ ] **Step 2: Human runs the protocol** (needs two devices and two people, or one person with a phone as B) **and fills in the table**
- [ ] **Step 3: Record the verdict in `docs/open-decisions.md` under R1**, choosing spec §9.4 outcome (a), (b) or (c) and stating which output mode M4 must use
- [ ] **Step 4: Commit**

```bash
git add spikes/audio-echo/README.md docs/open-decisions.md
git commit -m "spike(audio): record echo-cancellation verdict (R1)"
```
