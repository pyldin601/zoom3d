# Lobby — design spec

Status: approved design, 2026-10-09. Decision record: [open-decisions.md](../../open-decisions.md) D17.

## 1. Intent

The join screen (`/r/<id>`) becomes a lobby where you set yourself up before entering: camera, microphone,
name and picture. You see what others will see and hear that your mic works, so you never walk in with the
wrong device or with the camera on by surprise.

In scope:
- Camera: choose a device, turn it off. Off **stops** the camera (its light goes out), here and in the room.
- Microphone: choose a device, mute it, see its level.
- Name, and an avatar picture (choose / remove).
- Join.
- Remembering all of the above per browser.

Out of scope:
- Speaker (output device) choice.
- Switching devices from inside the room. The room's Cam button stops and restarts the camera on the
  device picked in the lobby; the Mic button only mutes.
- Background effects, a "test speaker" sound.

## 2. Look

The sketch was agreed in chat on 2026-10-09 ("ours", minimal, pencil only with the camera off).

```
┌──────────────────────────┐
│        ╭────────╮        │   disc: 176 px circle, the size of the
│       ╱  face /  ╲       │   avatar disc others see in the room
│      │  picture /  │     │   green ring around it = mic level
│       ╲ initials ╱ (✎)   │   ✎ only while the camera is off
│        ╰────────╯        │
│    [📷|▾]     [🎤|▾]     │   split buttons: icon toggles, ▾ opens the device menu
│  [       Roman        ]  │   name, centred, placeholder "Your name"
│  [         Join        ] │
│  Camera blocked: allow…  │   one error line, only when there is one
└──────────────────────────┘
```

- **Disc.** Camera on: the live framed crop (the framer's canvas, the exact picture peers receive).
  Camera off: the avatar picture, else the initials of the typed name, plus the pencil.
- **Pencil** (bottom-right of the disc, camera off only) opens a small menu: "Choose picture…" and, when
  there is a picture, "Remove". Picking and encoding work as today (`makeAvatar`, §8.1 of the main spec);
  Join waits while a picture is encoding.
- **Mic ring.** A ring around the disc whose width follows the mic level (0–6 px), drawn from an
  `AnalyserNode`. Muted or no mic: no ring.
- **Split buttons.** The icon half toggles the device (`ti-video` / `ti-video-off`; red when off). The
  chevron opens a menu of devices from `enumerateDevices()`, the current one ticked. A device that is
  unavailable (blocked, none present, insecure context) shows as off with its menu empty and its
  toggle disabled.
- The "Headphones recommended." hint and the field labels are gone.

## 3. Behaviour

### 3.1 Opening the lobby
1. Load the saved preferences (§3.5).
2. Request media for the devices saved as on, with their saved `deviceId` (`{ ideal: id }`, so a missing
   device falls back to the default). A camera saved as off is never opened. The mic is opened even
   when saved as muted, because mute keeps the track (§3.3).
3. Each device is requested on its own (`getUserMedia({ video })`, `getUserMedia({ audio })`), so a
   blocked camera never costs the mic or the reverse. This replaces `captureLocalMedia`'s fallback chain.
4. After the first successful request, `enumerateDevices()` fills the menus. Before permission is
   granted the labels are empty; the menu shows "Camera 1", "Microphone 1", …
5. `navigator.mediaDevices` `devicechange` refreshes the menus. If the device in use disappears, the
   track ends; the lobby restarts that device on the default.

The browser asks for permission as soon as the invite link opens, not on Join. That needs no user
gesture.

### 3.2 Camera
- **Off:** stop the camera track (`track.stop()`), so the light goes out. The framer keeps its canvas
  track but stops drawing.
- **On:** `getUserMedia({ video: { ...VIDEO_CONSTRAINTS, deviceId } })` and hand the new track to the
  framer.
- **Choosing a device** while on: open the new one, swap it into the framer, then stop the old one. While
  off: only remember the choice.
- Failure to open shows the error line and leaves the camera off.

### 3.3 Microphone
- **Off:** `track.enabled = false` (muted, track kept, so unmuting is instant and the transceiver keeps
  its track).
- **Choosing a device:** open the new track with `AUDIO_CONSTRAINTS` plus `deviceId`, replace it in the
  lobby stream and the meter, stop the old one. Lobby only.

### 3.4 Join
- Validates the name as today (`sanitizeName`).
- Hands the live media (§4.1) to `joinRoom`, which no longer calls `getUserMedia` itself.
- Resumes the `AudioContext` synchronously in the click handler (autoplay policy), then reuses it for
  the spatial audio engine.
- The room starts with the lobby's on/off states: `media` is published with them.

### 3.5 Remembered
- `zoom3d.name` and `zoom3d.avatar`: unchanged.
- New `zoom3d.media`: `{ cam: boolean, mic: boolean, camId: string | null, micId: string | null }`.
  Parsed defensively; anything invalid falls back to `{ cam: true, mic: true, camId: null, micId: null }`.
- Saved on every change in the lobby and when the room's Cam/Mic buttons are used.

### 3.6 Errors (one line under Join)
| Situation | Text | Device state |
|---|---|---|
| Not a secure context | Camera and mic need HTTPS. | both unavailable |
| Camera blocked (`NotAllowedError`) | Camera blocked: allow it in the address bar. | camera unavailable |
| Mic blocked | Microphone blocked: allow it in the address bar. You can still listen. | mic unavailable |
| No camera / no mic (`NotFoundError`) | No camera found. / No microphone found. | unavailable |
| Busy (`NotReadableError`) | Camera is in use by another app. (or Microphone …) | off, can retry |
| Picture too big / unreadable | as today | — |

The in-room banner for missing devices (`PROBLEM_TEXT` in `main.ts`) stays for devices that are
unavailable at Join.

## 4. Structure

### 4.1 Lobby media (`apps/web/src/media/local-media.ts`, replaces `capture.ts`)
A small controller that owns local media from the lobby onward:

```ts
interface LocalMediaController {
  readonly stream: MediaStream;            // framer canvas track + mic track (if any)
  readonly framer: Framer;
  state(): { cam: boolean; mic: boolean; camAvailable: boolean; micAvailable: boolean };
  setCam(on: boolean): Promise<void>;      // stop / restart the camera (§3.2)
  setMic(on: boolean): void;               // mute / unmute (§3.3)
  useCamera(deviceId: string): Promise<void>;
  useMic(deviceId: string): Promise<void>; // lobby only
  devices(): Promise<{ cams: Device[]; mics: Device[] }>;
  onChange: (() => void) | null;           // state or devices changed
}
```

It takes an env (`getUserMedia`, `enumerateDevices`, `isSecureContext`, `createFramer`) so unit tests
use fakes, like `capture.ts` today.

### 4.2 Framer: swappable camera
- `createFramer` no longer takes a `rawTrack` up front. It gains `setCamera(raw: MediaStreamTrack | null)`.
- The canvas track (`track`) exists from creation, with or without a camera. With no camera nothing is
  drawn and the track is disabled.
- `sendTrack` is the raw camera while the tab is hidden (as today) and the canvas track otherwise,
  including when there is no camera. `onSendTrackChange` fires on `setCamera` too.

### 4.3 Call and mesh
- The mesh always has a video track to send (the canvas), so the video transceiver is `sendrecv` from
  the first connection, even for someone who joins with the camera off. Turning the camera on later is
  a camera restart inside the framer, never a renegotiation. **No mesh changes.**
- The call's `setCam` calls `LocalMediaController.setCam` and publishes `media`. Main spec §8 changes
  from "the video track is absent or disabled" to "the canvas track is always sent; receivers rely on
  `cam` in `media`".
- A player whose camera is unavailable for the whole session still sends the (disabled, near-zero
  bitrate) canvas track.

### 4.4 UI (`apps/web/src/ui/lobby.ts`, replaces `showJoin` in `screens.ts`)
- `showLobby(root, opts)` renders §2 from a `LocalMediaController`, the saved name and avatar, and
  `onJoin(name, avatar)`.
- The disc shows the framer's canvas through a `<video muted playsinline>` on `framer.track`. The render
  loop keeps drawing the map behind the lobby, and a visible playing video may pace it to 30 fps; that is
  acceptable for a backdrop. The preview element is removed on Join, so the room is unaffected
  (`e2e/frame-rate.spec.ts` guards that).
- Mic meter: an `AnalyserNode` on the mic track in the shared `AudioContext`, sampled on
  `requestAnimationFrame` while the lobby is shown, stopped on Join.
- The `AudioContext` is created when the lobby opens. If the browser keeps it `suspended`, the lobby
  calls `resume()` on its first `pointerdown`/`keydown`; until then the ring stays still.

### 4.5 `main.ts`
- The route `/r/<id>` creates the `AudioContext` and the `LocalMediaController`, then calls `showLobby`.
- `joinRoom(roomId, name, avatar, local, audioCtx)` drops the capture step and builds the call from
  `local`.
- The room bar's `MediaControls` read `camAvailable`/`micAvailable` from the controller; `onCam` awaits
  `local.setCam`.

## 5. Testing

Unit (Vitest), written first:
- `local-media`: per-device requests; a blocked camera keeps the mic; saved-off camera is never
  requested; `setCam(false)` stops the track, `setCam(true)` requests with the chosen `deviceId`;
  `useCamera` while on swaps then stops the old track, while off only records; `useMic` replaces the
  stream's audio track; `devicechange` with the device gone restarts on default; error names map to
  §3.6 states.
- Media prefs store: round-trip, defaults for missing or malformed JSON.
- Framer: canvas track exists with no camera; `setCamera` swaps the source and fires
  `onSendTrackChange`; `setCamera(null)` stops drawing.
- `lobby.ts` (jsdom): pencil hidden with the camera on and shown with it off; Remove only with a picture;
  initials follow the name; device menus list labels or "Camera 1"; Join disabled while encoding; name
  validation message; error line texts.

E2E (Playwright, fake media devices):
- Lobby shows the preview and both device menus; Join enters the room (update the existing specs' join
  helper).
- Camera off in the lobby → join → the peer sees the avatar picture; turn the camera on in the room →
  the peer sees live video (the canvas transceiver carried it without renegotiation).
- `e2e/frame-rate.spec.ts` still passes.

Manual (Chrome; Firefox/Safari not yet checked): the camera light goes out on Cam off, in the lobby and
in the room; device switching with a second camera/mic; the permission prompt on opening an invite link.
