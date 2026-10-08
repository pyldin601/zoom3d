# Audio echo spike (throwaway)

Answers risk **R1** from the [design spec](../../docs/superpowers/specs/2026-10-08-zoom3d-design.md) §9.4:
does echo cancellation still work when remote WebRTC audio plays through the spatial Web Audio
graph? Nothing here is reused by the real app.

## Run

```bash
npm install
npm run cert   # self-signed cert in .cert/ (gitignored)
npm start      # prints https://<lan-ip>:8443/
```

Open the printed LAN URL on both devices and accept the certificate warning. Click **Start**
and allow the microphone. The status should read `connected`, and the log should show
`"echoCancellation":true`.

- `?fake=1` sends a beeping tone instead of the mic. It's useful for judging panning,
  distance and reverb alone with headphones.
- `?noaec=1` captures with echo cancellation **off** (the positive control below).
- `HTTP=1 PORT=8080 npm start` serves plain HTTP. This only works on `localhost`, for local checks.

**Controls:**
- **Output mode:**
  - `element` plays the raw stream (baseline; the browser's AEC is expected to work).
  - `webaudio` plays the spatial graph to `AudioContext.destination`.
  - `webaudio-element` plays the spatial graph via a `MediaStreamAudioDestinationNode` into an `<audio>` element.
- **Panning:** HRTF or equalpower. **Occluded** adds wall muffling.
- **Pad:** drag the orange dot. The listener is the blue triangle facing up; rings mark REF (1.5) and MAX (12 tiles).

## Echo test protocol

**Setup (this matters more than anything else):**
- **Device A:** laptop on its **built-in speakers**, no headphones, normal conversation volume.
  Set panning to **equalpower** (the spec's speakers mode).
- **Device B:** any device with **closed headphones**, in a **different room**, out of earshot
  of A. Otherwise A's mic picks up B's voice straight from the air and sends it back, which
  sounds like echo in every mode and the cancellation can't remove it.
- **B always uses `element` mode**, so B's playback is the known-good path. Only A's mode varies.
- If B sees `socket closed 4000 full` after a phone slept, wait about 10 s (the relay drops
  dead peers) and press Start again.

**Before the table:**
1. **Hearing check:** someone near A speaks or taps the laptop, and B confirms hearing it.
   If B hears nothing, stop and fix B's playback first; otherwise every row reads "none".
2. **Positive control:** open A with `?noaec=1` (echo cancellation off), `element` mode.
   B counts aloud and should hear **clear** echo. If not, raise A's volume until they do.
   That proves echo is detectable in this setup. Then reload A without `?noaec`.
3. **Baseline sanity:** with A in `element` mode and cancellation on, B should hear **no**
   echo. If B does, that's a setup leak (rooms too close, volume too high), not a result.
   Fix the setup and repeat.

**Per row** (each A browser × each A mode):
1. Select the mode on A, leaving the dot at about 2 tiles front-right.
2. B talks continuously for ~5 s first, so the canceller can adapt after the switch.
3. B counts aloud 1–10 and records the echo: **none / faint / clear**.
4. Optional: repeat at 1 tile (louder) to stress the canceller.

| A browser + version | A OS | mode | echo heard by B | notes |
|---|---|---|---|---|
| Chrome | | element | | |
| Chrome | | webaudio | | |
| Chrome | | webaudio-element | | |
| Firefox | | element | | |
| Firefox | | webaudio | | |
| Firefox | | webaudio-element | | |

**Verdict** (spec §9.4), decided per browser, then combined:
- (a) `webaudio` (graph → destination) is clean → M4 uses `webaudio`.
- (c) `webaudio` echoes but `webaudio-element` is clean → M4 routes via MediaStreamDestination → `<audio>`.
- (b) Both Web Audio modes echo → headphones required, plus a speakers-mode ducking fallback.
- **Split browsers:** pick the mode that is clean in both if one exists. Otherwise use
  per-browser routing and note it as a risk for M4.

## Result (2026-10-08)

Chrome on both devices: the user reported it "sounds good", with no echo problem heard. The per-row table was not filled in, and Firefox is not tested. Provisional verdict (a); see R1 in `docs/open-decisions.md`.

## Verified automatically so far (Chromium, `?fake=1`, two tabs)

- The connection is established, and rejoin after a peer reload works without reloading the survivor.
- Remote WebRTC audio reaches Web Audio (peak 0.32 for a 0.3 tone) while `#remote` is muted and playing.
- Graph output peak: 0.262 at 2 tiles, 0.05 at 8 tiles, 0.029 at 8 tiles occluded, 0 beyond MAX.
- The output modes are mutually exclusive (one audible path at a time).
