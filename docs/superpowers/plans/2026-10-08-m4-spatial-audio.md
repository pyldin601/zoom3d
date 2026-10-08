# M4 Spatial Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voices sound like the people are in the maze with you:
- louder when near and silent beyond range
- coming from their direction
- roomier with distance
- muffled through walls

A speaking ring lights up each talking avatar, and a debug panel lets you tune the curves by ear.

**Architecture:**
- **Shared code** (`packages/shared`) gains the §9.2 curve functions and a grid line-of-sight
  test. Both are pure and unit-tested.
- **`apps/web/src/audio/engine.ts`** owns one `AudioContext` graph:
  - a shared synthesized-impulse reverb bus
  - a per-peer chain `MediaStreamSource → lowpass → (dry → PannerNode) + (send → reverb)`, with an `AnalyserNode` tap
  - an update step that sets the listener pose, per-voice gains and pan positions each frame,
    with occlusion checked every 100 ms
- **Call integration:** the call layer routes each remote stream into the engine. The hidden
  `<video>` elements are muted but keep playing, which Chrome needs to feed WebRTC audio into
  Web Audio (spike-verified).
- **Rendering:** sprites take a `speaking` level for the ring glow.
- **Debug panel** (`` ` `` key in a room, or `?debug`) edits the engine settings live and
  persists them in `localStorage`.

**Tech Stack:** as M3. No new dependencies. Web Audio API (`PannerNode` HRTF, `ConvolverNode`, `BiquadFilterNode`, `AnalyserNode`).

**Spec:** [docs/superpowers/specs/2026-10-08-zoom3d-design.md](../specs/2026-10-08-zoom3d-design.md): §9.1 (graph), §9.2 (curves), §9.3 (updates, speaking level, debug panel, `AudioContext` on Join), §9.4 (R1: route to `ctx.destination` per the provisional verdict, recorded in `docs/open-decisions.md`), §5 (speaking ring). Firefox verification of R1 stays a manual M5 item.

## Global Constraints

- **Curves** (spec §9.2): `n = clamp((d − ref)/(max − ref), 0, 1)`,
  `dry = (1 − n)²`, `send = (0.15 + 0.35·n)·(1 − n⁴)`. Defaults: `ref = 1.5`, `max = 12`
  tiles. Occluded: `dry` and `send` × `occludedGain` (default 0.5), and the lowpass goes from
  16000 Hz down to `muffleHz` (default 700).
- **Smoothing** with `setTargetAtTime`: τ 0.05 s for distance and pan, τ 0.15 s for occlusion
  changes. Never step a gain.
- **Occlusion:** re-evaluated per voice at most every 100 ms with `hasLineOfSight(map, listener, source)`.
- **Coordinates:** map `(x, y)` maps to audio `(x, 0, y)`. The listener is at the camera, with
  forward `(cos a, 0, sin a)` and up `(0, 1, 0)`. In this right-handed frame the listener's
  right is `(−sin a, 0, cos a)`, matching the renderer's camera plane.
- **PannerNode:** `distanceModel: 'linear'`, `rolloffFactor: 0` (it gives direction only),
  and `panningModel` from settings: `'HRTF'` (default, headphones) or `'equalpower'` (speakers).
- **Reverb:** one shared `ConvolverNode` with a synthesized stereo impulse (decorrelated noise,
  −60 dB at 0.8 s, 10 ms pre-delay) into a `reverbGain` = `settings.reverb` (default 1).
- **Voices beyond `max`:** gains 0, but nodes stay alive (cheap to resume).
- **`AudioContext`:** created and `resume()`d synchronously inside the Join click handler,
  before any `await`.
- **Speaking level:** from an `AnalyserNode` (`fftSize` 512) on the voice's source, before
  any gain, so it reflects talking rather than distance.
  `target = clamp((rms − 0.01) / 0.09, 0, 1)`. Attack is instant; release is exponential with
  τ 0.3 s.
- **Speaking ring:** the ring colour is mixed toward white by `0.8 × speaking`.
- **Settings:** `{ ref, max, reverb, muffleHz, occludedGain, panning }`, persisted in
  `localStorage['zoom3d.audio']`. Every read and write is wrapped in try/catch, and invalid
  stored values fall back to defaults.
- **No allocations per frame** in `engine.update`: reuse the analyser buffers and voice objects.

## Review Focus

1. **Two peers at exactly the same position** (distance 0): no NaN in gains or pan, the line
   of sight is clear, and the panner sits at the listener. Tested in Tasks 1 and 3.
2. **A peer leaving, or a stream replaced on reconnect:** the old voice is fully disconnected
   (source, filters, analyser), with no doubled voice and no leak. Tested in Tasks 3 and 4.
3. **`AudioContext` suspended** (autoplay policy, or the tab backgrounded and resumed): the
   engine resumes on the next user gesture, and the update never throws. Tested in Task 3.
4. **Settings edge values from the panel or stale storage** (`max ≤ ref`, negative or `NaN`
   reverb, unknown panning): clamped or replaced with defaults, and the graph never receives
   non-finite values. Tested in Tasks 1 and 5.
5. **Remote audio playing twice** (element unmuted plus Web Audio): the element is always
   muted once the engine owns the voice. Tested in Tasks 4 and 6.

---

### Task 1: Shared audio curves and settings validation

**Files:**
- Create: `packages/shared/src/audio/curves.ts`
- Test: `packages/shared/src/audio/curves.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces:
  - `interface AudioSettings { ref: number; max: number; reverb: number; muffleHz: number; occludedGain: number; panning: 'HRTF' | 'equalpower' }`
  - `const DEFAULT_AUDIO_SETTINGS: AudioSettings` (1.5, 12, 1, 700, 0.5, `'HRTF'`)
  - `const MUFFLE_OPEN_HZ = 16000`, `TAU_POSITION = 0.05`, `TAU_OCCLUSION = 0.15`, `OCCLUSION_INTERVAL_MS = 100`
  - `normalizeAudioSettings(v: unknown): AudioSettings`. Each field is taken if finite and in
    range, otherwise the default:
    - `ref` in [0.1, 10]
    - `max` in [`ref` + 0.5, 64]; if `max ≤ ref` then `max = ref + 0.5`
    - `reverb` in [0, 3]
    - `muffleHz` in [100, 16000]
    - `occludedGain` in [0, 1]
    - `panning` must be one of the two strings
  - `voiceGains(distance: number, occluded: boolean, s: AudioSettings): { dry: number; send: number }`

- [ ] **Step 1: Write failing tests**
  - defaults: dry is 1 at 0 and at `ref`, 0 at `max` and beyond; send is 0.15 at 0 and 0 at
    `max`. Between `ref` and `max`, dry falls strictly and send/dry rises strictly (step 0.5).
  - occluded halves both gains at 3 tiles
  - distance 0 gives finite values, and `NaN` distance gives `{dry: 0, send: 0}` (Review Focus 1)
  - `normalizeAudioSettings`:
    - `null`, `{}` and `'x'` give the defaults
    - `{ref: 5, max: 3}` gives `max` 5.5
    - `{reverb: -1}`, `{reverb: NaN}` and `{panning: 'surround'}` give the default for that field (Review Focus 4)
    - valid custom values are preserved
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: pass.
- [ ] **Step 5: Commit:** `feat(shared): spatial audio curves and settings validation`

### Task 2: Grid line of sight

**Files:**
- Create: `packages/shared/src/geometry/los.ts`
- Test: `packages/shared/src/geometry/los.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `GameMap`, `tileAt` (M1).
- Produces: `hasLineOfSight(map: GameMap, ax: number, ay: number, bx: number, by: number): boolean`.
  It walks the grid cells between the points with DDA and returns false if any wall cell
  strictly between them is hit. Both endpoints' own cells are ignored, so a voice right
  against a wall is not occluded by it. It is true when the points are identical, never
  throws, and the walk is bounded.

- [ ] **Step 1: Write failing tests** on `'1111111\n1.....1\n1..1..1\n1S....1\n1111111'` (a pillar at `(3, 2)`):
  - `(1.5,1.5)→(5.5,1.5)` is true (open row)
  - `(1.5,2.5)→(5.5,2.5)` is false (pillar in between)
  - `(2.5,2.5)→(2.5,2.5)` is true (co-located, Review Focus 1)
  - diagonal `(1.5,3.5)→(5.5,1.5)` is false (it crosses the pillar's cell); diagonal `(1.5,1.5)→(2.5,3.5)` is true
  - an endpoint inside a wall cell, `(3.5,2.5)→(5.5,2.5)`, is true (the endpoint's own cells are ignored)
  - on LEVEL1, spawn `(29.5,50.5)` → `(29.5,44.5)` is false: the wall line at row 48 separates the blue rooms (check by hand from the grid; adjust the target to a cell behind a wall if needed and note it in the test)
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: pass.
- [ ] **Step 5: Commit:** `feat(shared): grid line-of-sight for audio occlusion`

### Task 3: Audio engine

**Files:**
- Create: `apps/web/src/audio/engine.ts`, `apps/web/src/audio/fake-audio.ts` (test double)
- Test: `apps/web/src/audio/engine.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; `GameMap`, `PlayerState`.
- Produces:
  - `makeImpulse(ctx: BaseAudioContext, seconds = 0.8, preDelay = 0.01): AudioBuffer`
  - `speakingLevel(prev: number, rms: number, dtSeconds: number): number` (pure)
  - `interface AudioEngine`:
    - `attach(peerId: string, stream: MediaStream): void`. Idempotent per stream; replacing a
      peer's stream disconnects the old voice first.
    - `detach(peerId: string): void`
    - `update(now: number, listener: PlayerState, sources: ReadonlyMap<string, { x: number; y: number }>): void`
    - `speaking(peerId: string): number`, in 0..1
    - `inputLevel(peerId: string): number`, the latest RMS before gains (for E2E and the panel)
    - `settings(): AudioSettings` and `setSettings(s: AudioSettings): void`
    - `resume(): Promise<void>`
    - `dispose(): void`
  - `createAudioEngine(opts: { ctx: AudioContext; map: GameMap; settings?: AudioSettings }): AudioEngine`
  - Behaviour:
    - `update` sets the listener (AudioParams when present, else `setPosition`/`setOrientation`).
    - For each attached voice that has a source position, it sets the panner position and the
      dry/send targets from `voiceGains`, and re-checks occlusion when 100 ms have passed.
    - A voice without a position in `sources` is ramped to silence.
    - `setSettings` updates `panningModel` on every panner and the reverb gain.
    - `update` and `attach` swallow nothing silently, but they never throw because of a
      suspended context (they only schedule params).

- [ ] **Step 1: Write failing tests** with a `FakeAudioContext`. It provides node classes
  recording `connect`/`disconnect`, `AudioParam`s recording `setTargetAtTime(value, t, tau)`,
  a listener with `positionX/…` params, `createMediaStreamSource`, `createBuffer`, and a
  `state`/`resume()`. Analysers return a settable time-domain buffer.
  - `attach`:
    - builds source → lowpass, lowpass → dry → panner → destination, and lowpass → send → convolver → reverbGain → destination
    - the panner has `rolloffFactor 0` and `panningModel 'HRTF'`
    - an analyser is connected from the source
  - `update` with the listener at `(1.5,1.5,0)` and a voice at `(4.5,1.5)` in an open map:
    - the panner position targets `(4.5, 0, 1.5)`
    - dry targets `voiceGains(3, false).dry` with τ 0.05
    - the listener forward is `(1, 0, 0)`
  - the same position as the listener: all targets finite (Review Focus 1)
  - a wall between, after 100 ms: lowpass frequency targets 700 with τ 0.15 and dry is halved; earlier than 100 ms it isn't re-checked
  - a voice missing from `sources`: dry and send target 0
  - `detach` disconnects source, filter, gains, panner and analyser; attaching a new stream for the same peer disconnects the old chain first (Review Focus 2)
  - `setSettings({…, panning: 'equalpower', reverb: 0})` updates the panners and targets reverbGain 0
  - `speakingLevel`: from 0 with rms 0.1 gives 1 (instant attack); from 1 with rms 0 for 0.3 s gives ≈ e⁻¹; rms below 0.01 targets 0
  - with the context `state 'suspended'`, `update` does not throw and `resume()` calls `ctx.resume()` (Review Focus 3)
  - `makeImpulse`: 2 channels, length `round((0.8 + 0.01) × rate)`, the first 10 ms are zero, and the tail is quieter than the head
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: pass.
- [ ] **Step 5: Commit:** `feat(web): spatial audio engine (distance, HRTF pan, reverb, wall muffling)`

### Task 4: Route remote audio through the engine

**Files:**
- Modify: `apps/web/src/media/remote-media.ts`, `apps/web/src/media/call.ts`, and tests `call.test.ts`, plus a new `remote-media.test.ts` (happy-dom)

**Interfaces:**
- Consumes: Task 3 `AudioEngine`.
- Produces:
  - `CallOptions` gains `audio: Pick<AudioEngine, 'attach' | 'detach'> | null`
  - `onRemoteStream` calls `audio.attach(peerId, stream)` (in addition to faces)
  - peer drop and teardown call `audio.detach(peerId)` for each peer
  - `createRemoteMedia` elements are `muted = true` (they keep playing so Chrome feeds Web Audio)

- [ ] **Step 1: Write failing tests**
  - call: a remote stream for `b` calls `audio.attach('b', stream)`; `peerLeft('b')` and a new-identity welcome call `audio.detach('b')`
  - remote media: an attached element has `muted === true`, `autoplay`, `playsInline` and `srcObject` set (Review Focus 5)
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: pass.
- [ ] **Step 5: Commit:** `feat(web): play remote voices only through the spatial engine`

### Task 5: Audio settings persistence and debug panel

**Files:**
- Create: `apps/web/src/audio/settings-store.ts`, `apps/web/src/ui/audio-panel.ts`
- Test: `apps/web/src/audio/settings-store.test.ts`, `apps/web/src/ui/audio-panel.test.ts` (happy-dom)
- Modify: `apps/web/index.html` (panel styles)

**Interfaces:**
- Consumes: Task 1 `AudioSettings`, `normalizeAudioSettings`.
- Produces:
  - `loadAudioSettings(storage: Pick<Storage, 'getItem'> | null): AudioSettings`
  - `saveAudioSettings(storage: Pick<Storage, 'setItem'> | null, s: AudioSettings): void`.
    Both use the key `zoom3d.audio`, treat a throw as no storage, and `load` runs through `normalizeAudioSettings`.
  - `showAudioPanel(root: HTMLElement, opts: { settings: AudioSettings; onChange(s: AudioSettings): void; levels?: () => { name: string; speaking: number }[] } | null)`.
    - `null` removes the panel.
    - It shows range inputs: "Full volume within" (ref, 0.5–5 step 0.1), "Silent beyond"
      (max, 4–30 step 0.5), "Reverb" (0–2 step 0.05), "Wall muffle cutoff" (200–4000 Hz),
      "Wall attenuation" (occludedGain 0–1).
    - A "Headphones (HRTF) / Speakers" select controls panning, and a "Reset" button restores the defaults.
    - Each change calls `onChange(normalizeAudioSettings(next))`, with values shown next to the sliders.
    - Optional live speaking bars come from `levels()`.

- [ ] **Step 1: Write failing tests**
  - store:
    - a round trip through a fake storage
    - `getItem` throwing gives the defaults
    - stored `'{"max":"far"}'` gives the default `max` (Review Focus 4)
    - `null` storage gives the defaults, and save is a no-op
  - panel:
    - changing the "Silent beyond" slider to 20 calls `onChange` with `max: 20`
    - selecting Speakers gives `panning: 'equalpower'`
    - Reset gives the defaults
    - `showAudioPanel(root, null)` removes it
    - labels are rendered via `textContent`
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: pass.
- [ ] **Step 5: Commit:** `feat(web): audio tuning panel with persisted settings`

### Task 6: Wire it in (Join, frame loop, speaking ring, panel key)

**Files:**
- Modify: `apps/web/src/main.ts`, `apps/web/src/renderer/sprites.ts` (+test), `apps/web/src/input/keyboard.ts` (no change expected; `` ` `` is unbound), and docs `README.md`, `AGENTS.md`, `docs/roadmap.md`, `docs/open-decisions.md` (R1: still provisional for Firefox)
- Create: `apps/web/e2e/audio.spec.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- `Sprite` gains `speaking: number` (0..1). The ring colour is `mix(color, white, 0.8 × speaking)`;
  with a flat disc (`face: null`) the shaded edge uses the mixed colour too.
- `main.ts`:
  - In `joinRoom`, **before** any `await`:
    `const audioCtx = new AudioContext({ latencyHint: 'interactive' }); void audioCtx.resume();`.
    Then `audio = createAudioEngine({ ctx: audioCtx, map, settings: loadAudioSettings(storage()) })`,
    passed to `createCall({ …, audio })`.
  - A `pointerdown`/`keydown` listener calls `audio.resume()` when the context is suspended (Review Focus 3).
  - **Each frame:** build a reused `Map` of peer positions from the interpolated samples, call
    `audio.update(performance.now(), player, positions)`, and give sprites
    `speaking: audio.speaking(id)`.
  - **Panel:** `` ` `` (Backquote) in a room, ignored in text inputs, or `?debug` at join,
    toggles `showAudioPanel(ui, …)`. `onChange` calls `audio.setSettings` and `saveAudioSettings`.
  - `__game` gains `audio` (dev only).

- [ ] **Step 1: Write failing tests**
  - sprites: with `speaking: 1` the ring pixel equals `mix(RED, white, 0.8)`; with `speaking: 0` it equals `RED` (existing tests pass `speaking: 0`)
  - `audio.spec.ts`, two pages with Chrome's fake mic, which beeps:
    - within 15 s, A's `__game.audio.inputLevel(bobId) > 0.005` at least once (poll), so audio flows into Web Audio
    - `__game.audio.speaking(bobId)` reaches > 0 at least once
    - every `#media video` on A has `muted === true` (Review Focus 5)
    - pressing `` ` `` shows the panel (text "Silent beyond"); pressing it again hides it
- [ ] **Step 2: Run** `pnpm test && pnpm e2e`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the wiring.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm lint && pnpm e2e`. Expected: all pass (repeat `pnpm e2e` twice for stability).
- [ ] **Step 5: Manual check (human, headphones):** two browsers on the same room.
  - Walking away fades the voice to silence by about 12 tiles.
  - Turning moves the voice left and right.
  - Stepping behind a wall muffles it.
  - Far voices sound roomier.
  - The panel's sliders change it live.
- [ ] **Step 6: Docs:** README status (M4), AGENTS (audio notes: Chrome needs the muted
  element; context created on Join), roadmap ✅, decision log R1 (Chrome verified via the
  spike; Firefox pending M5).
- [ ] **Step 7: Commit:** `feat(web): spatial voices, speaking ring and tuning panel; e2e`
