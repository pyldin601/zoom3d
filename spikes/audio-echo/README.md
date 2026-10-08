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
- `HTTP=1 PORT=8080 npm start` serves plain HTTP. This only works on `localhost`, for local checks.

**Controls:**
- **Output mode:**
  - `element` plays the raw stream (baseline; the browser's AEC is expected to work).
  - `webaudio` plays the spatial graph to `AudioContext.destination`.
  - `webaudio-element` plays the spatial graph via a `MediaStreamAudioDestinationNode` into an `<audio>` element.
- **Panning:** HRTF or equalpower. **Occluded** adds wall muffling.
- **Pad:** drag the orange dot. The listener is the blue triangle facing up; rings mark REF (1.5) and MAX (12 tiles).

## Echo test protocol

- **Device A:** laptop on its **built-in speakers**, no headphones.
- **Device B:** any device with **headphones** (a phone works).
- Person B talks. Echo means B hears their own voice come back from A.

For each A browser (Chrome, Firefox) and each mode:
1. Select the mode on A. Leave the dot at about 2 tiles, front-right.
2. Speakers on A at a normal conversation volume.
3. B counts aloud from 1 to 10 and notes the echo: **none / faint / clear**.
4. Optional: repeat at 1 tile (louder) to stress the canceller.

| A browser | mode | echo heard by B | notes |
|---|---|---|---|
| Chrome | element | | |
| Chrome | webaudio | | |
| Chrome | webaudio-element | | |
| Firefox | element | | |
| Firefox | webaudio | | |
| Firefox | webaudio-element | | |

**Verdict** (spec §9.4):
- (a) No echo in a Web Audio mode → use that mode.
- (b) Echo in both Web Audio modes → headphones required, plus a speakers-mode ducking fallback.
- (c) Only `webaudio-element` is clean → M4 routes through a MediaStreamDestination into `<audio>`.

## Verified automatically so far (Chromium, `?fake=1`, two tabs)

- The connection is established, and rejoin after a peer reload works without reloading the survivor.
- Remote WebRTC audio reaches Web Audio (peak 0.32 for a 0.3 tone) while `#remote` is muted and playing.
- Graph output peak: 0.262 at 2 tiles, 0.05 at 8 tiles, 0.029 at 8 tiles occluded, 0 beyond MAX.
- The output modes are mutually exclusive (one audible path at a time).
