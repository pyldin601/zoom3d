# Boombox — design spec

Status: draft for review, 2026-10-09. Decision record: [open-decisions.md](../../open-decisions.md) D16.

## 1. Intent

A player can play an audio file from their computer to the room, the way someone brings a boombox
to a party. The music is spatial: it comes from the carrier's position, through the same engine as
voices (spec §9), so you hear it louder near them and can walk away from it. While it plays, the
carrier's avatar carries a boombox.

In scope:
- `B` opens a file picker; the picked track plays **once** to everyone.
- `B` during playback stops it early; the track ending stops it too.
- Others see the boombox on the carrier's avatar; the carrier sees it in first person.
- Several players can play at once, each from their own position.

Out of scope:
- Pause, seek, volume, loop, playlists, showing the track name.
- Speakers that pulse with the music (sketch "C"; possible later, the engine already measures the level).
- Stereo or higher-bitrate music (§5.3).
- Anything stored or relayed by the server beyond an on/off flag.

## 2. Look

The sketch was agreed in chat on 2026-10-09: variant "D", carried by the handle.

### 2.1 On the avatar

- A boombox hangs from a fist gripping its handle, on the **viewer's left** of the disc: the
  avatar's right hand, opposite the drink (held items spec §2).
- Like the drink, it is fixed in screen space beside the billboard, and nothing is drawn when the
  boombox is off.
- Pixel map, 16×12, letters disjoint from the held-item palette so both share one `toHeldSprite`:

```
.....oooooo.....      o hand outline   s skin   l finger crease
....osssssso....      h handle         k body outline
....hllllllh....      m chrome         n speaker grill
....h.oooo.h....      i cone ring      d cone centre
kkkkkkkkkkkkkkkk      e cassette frame y cassette label
kmmmmmmmmmmmmmmk      x button
kmnnnmeeeemnnnmk
knninneyyenninnk
knidineyyenidink
knninneeeenninnk
kmnnnmmxxmmnnnmk
kkkkkkkkkkkkkkkk
```

Colours: `k #1e1e1e`, `m #a7afb8`, `n #3a3a3a`, `i #6e6e6e`, `d #111111`, `e #555555`,
`y #e8a317`, `x #dd3333`, `h #4a4a4a`; `o s l` as the held items.

Geometry, in units of the disc's on-screen radius `r` (constants in `renderer/boombox.ts`):
- One texel is `HELD_TEXEL` (0.08 r), so the boombox is 1.28 r wide and 0.96 r tall.
- Its right edge is at `screenX − 0.15 r`, mirroring the drink's left edge at `+0.15 r`:
  `BOOMBOX_LEFT = −(0.15 + 16 × 0.08) = −1.43`.
- Its top is 0.15 r below the horizon (`BOOMBOX_TOP = −0.15`), so it hangs to about 1.1 r below
  the disc centre, just past the disc's bottom edge.
- Walking: it rises with the drink's `itemBob` (half a step behind the disc), so it swings.
- Floor shadow, same style and pass as the drink's: centred `(BOOMBOX_LEFT + 0.64) × AVATAR_RADIUS`
  along the viewer's right (i.e. 0.79 r to the left), radius `0.64 × AVATAR_RADIUS` ≈ 0.22 tiles.
- It is depth-tested per column like the disc and drawn after it.
- A sip moves only the drink; the boombox stays put.

### 2.2 First person

- You see your boombox peeking in at the **bottom-right**, mirroring your drink at the
  bottom-left. The sprite is symmetric, so it is not mirrored.
- Texel `OWN_TEXEL` (4.6% of the height), as the drink.
- Its right edge is at 88% of the width, so it stays clear of the camera self-view, which covers
  about the rightmost 9% (`index.html` `.selfview`: 0.6 em + 4.5 em at 3.2% of the height per em).
- 50% of the sprite hangs below the bottom edge (`OWN_BOOMBOX_CROP`): the fist, handle and the
  top of the body show.
- Walking: the same drop as the drink, and the opposite sway (the other hand).
- Drawn over the scene next to `renderOwnHeld`, only in a room, only while playing.

These numbers come from the sketch and get tuned by eye at implementation.

## 3. Behaviour (carrier)

`apps/web/src/media/boombox.ts`, `createBoombox({ ctx, document, onTrack, onChange })`.

**Trigger:** in a room, `KeyB` without repeat and not while typing in an input (as the held-item
keys in `main.ts`). States are `off` and `playing`:
- `off` → `B` clicks a hidden `<input type="file" accept="audio/*">`. The keydown is the user
  activation the picker needs. Cancelling the picker does nothing.
- File chosen → `playing`: the file becomes an object URL on a single reused `<audio>` element
  (`loop = false`), and `play()` is called. Then `onTrack(track)` and `onChange(true)`. The input
  is reset (`value = ''`) so the same file can be picked again.
- `playing` → `B`, the element's `ended` or `error` event, a rejected `play()`, or leaving the room
  stops it: pause, drop the `src`, revoke the URL, `onTrack(null)`, `onChange(false)`.

**Graph:** created once on first use, from the `AudioContext` made in the Join click:

```
<audio> → MediaElementSource ─┬→ MediaStreamDestination → track (to the mesh)
                              └→ GainNode (BOOMBOX_SELF_GAIN) → ctx.destination
```

- The carrier hears their own music centred and dry at `BOOMBOX_SELF_GAIN = 0.5` (tuned by ear),
  not spatialised: it's in their hand.
- `MediaElementSource` can be created only once per element, hence the single reused element.
- With no `AudioContext` (no engine), the boombox is unavailable and `B` does nothing.
- Opening the file dialog may release pointer lock; clicking the view re-locks as usual.

## 4. Spatial playback (listeners)

- `AudioEngine.attach(key, stream, owner = key)`: a voice keyed `key` takes its position from
  `sources.get(owner)` in `update`. Voices stay keyed by peer id; a boombox is attached as
  `boombox:<peerId>` with `owner = peerId`. The key string is built once at attach, never per frame.
- So the music gets the distance curve, panning, reverb and wall muffling of a voice, from the
  carrier's position (the hand's offset of about 0.3 tiles is ignored).
- It has its own key, so it never lights the carrier's speaking ring.
- Chrome only feeds remote WebRTC audio into Web Audio while the stream plays in an element, so
  the boombox stream also goes through `remote.attach('boombox:<peerId>', stream)` (muted, hidden,
  as the voice's).

## 5. Transport (`apps/web/src/media/mesh.ts`)

### 5.1 A pre-allocated transceiver

- The initiator adds a third transceiver after video and mic:
  `addTransceiver(boomboxTrack ?? 'audio', { direction: 'sendrecv' })`. The m-line order is fixed
  (video, mic, boombox), so both sides find it at `getTransceivers()[2]`, with or without a mic
  (a mic-less initiator still adds a recvonly audio transceiver second).
- The answerer, in `attachTracks`, handles index 2 apart from the kind loop: direction
  `sendrecv` and `replaceTrack(current boombox track)`. This happens **even with no local stream**
  (a player with no mic and no camera can still play music). Today `attachTracks` skips
  everything without a local stream, and would attach the mic to any audio transceiver.
- `MediaTransport.setBoomboxTrack(track | null)` remembers the track and calls
  `replaceTrack` on index 2 of every connection; new connections pick it up at creation (initiator)
  or in `attachTracks` (answerer).
- Turning the boombox on or off **never renegotiates**: both directions are already `sendrecv`,
  and `replaceTrack` doesn't fire `negotiationneeded`. That keeps clear of the initiator, glare and
  watchdog logic.

### 5.2 Receiving

`ontrack` checks `event.transceiver === pc.getTransceivers()[2]` first and calls the new
`onRemoteBoombox(peerId, new MediaStream([event.track]))`; everything else goes to
`onRemoteStream` as now. The track arrives with the connection and is silent while the carrier
sends `null`, so nothing waits for the flag.

### 5.3 Quality

Chrome's default Opus for this track is mono at about 32 kbps. That's acceptable for a point source
in a retro room. Raising it (sender `maxBitrate`, or `stereo=1` in the SDP) is out of scope.
The track bypasses the mic's echo cancellation, noise suppression and gain control: it comes from
Web Audio, not `getUserMedia`.

## 6. Protocol (extends design spec §7.2)

Same pattern as `held` (held items spec §4):
- Client → server: `boombox { on: boolean }`. Strict: anything else fails `parseClientMessage`.
- Server → client: `peer_boombox { id, on }`. `PeerInfo` gains `boombox: boolean`. Lenient: a
  missing or non-boolean `boombox` reads as `false`.
- The client sends its current state after every `welcome` (fresh or resumed), including `false`.
- No limit of its own: the 60 msg/s bucket covers it, and turning it on needs a file pick.
- The flag drives only the sprite. Audio needs no flag (§5.2).

## 7. Server (`apps/server`)

- `Peer.boombox` starts `false` and is included in `info()`.
- `Lobby.boombox(conn, msg)` sets it and broadcasts `peer_boombox` to the rest of the room.
- `server.ts` routes `msg.type === 'boombox'`.
- Resume keeps the slot and its flag; the client resends it anyway.

## 8. Client wiring

- `net/session.ts`: `setBoombox(on)` (stored and resent after `welcome`), and `peer_boombox` sets
  `peer.info.boombox`.
- `media/call.ts`:
  - `setBoomboxTrack(track | null)` forwards to the mesh and is reapplied to a mesh recreated
    after an identity change.
  - `onRemoteBoombox` → `remote.attach(key, stream)` and `audio.attach(key, stream, peerId)`.
  - `drop`/`teardown` detach the `boombox:` key too.
- `main.ts`: the `B` key handler, the boombox created with the engine's context, `onTrack` → call,
  `onChange` → session and the own-view flag, and stopping it when leaving the room.
- Renderer: `Sprite` gains `boombox: boolean` from `peer.info.boombox`; `renderSprites` draws the
  boombox and its shadow (§2.1); `renderOwnBoombox(fb, on, bob, sway)` draws your own (§2.2).
- Dev only: `window.__game` exposes the engine's `inputLevel` for the e2e test.

## 9. Risks

- **Echo.** The carrier's mic hears their own speakers. Chrome's echo cancellation passed for Web
  Audio output (R1, provisional), but music is harder to cancel than speech. If it fails, others
  hear a second copy of the music from the carrier's voice. Verify by hand with speakers. The
  fallback is advice to wear headphones, not code.
- **Mixed versions.** A stale tab from before this change answers the third m-line with its mic
  (old `attachTracks`), so a new peer would hear that peer's voice twice, once as "boombox". Rooms
  are ephemeral and the web image ships as one unit, so this lasts until the stale tab reloads.
  Accepted.
- **Upload.** One more audio stream per peer while playing, ~32 kbps × (N−1). Negligible next to
  video.
- **Copyright.** The music is streamed live peer to peer and never stored, like a voice.

## 10. Testing

Unit (TDD, Vitest):
- Shared protocol: `boombox` parsing is strict; `peer_boombox` and `PeerInfo.boombox` are lenient.
- Server lobby: `info()` includes the flag; `boombox` relays `peer_boombox` to the rest of the
  room only; resume keeps it.
- Mesh (`fake-rtc.ts`, extended as needed): the initiator creates three transceivers; the answerer
  sets index 2 to `sendrecv` with and without a local stream and never puts the mic on it;
  `setBoomboxTrack` replaces the track on existing and new connections without
  `negotiationneeded`; `ontrack` on index 2 calls `onRemoteBoombox`, not `onRemoteStream`.
- Engine: a voice attached with an `owner` follows the owner's position.
- Call: the boombox stream goes to the remote element and the engine under `boombox:<id>` with
  owner `<id>`; `drop` detaches it; the track is reapplied to a recreated mesh.
- Boombox: `B` opens the picker when off and stops when playing; choosing a file plays it and
  reports the track and `true`; `ended`, `error` and a rejected `play()` turn it off and revoke
  the URL; a cancelled pick changes nothing.
- Renderer: the map is 16×12 with equal rows and known letters; the own-view boombox stays within
  the bottom-right and left of the self-view area.

E2E (Playwright, fake media): two pages in a room; page A presses `B` and sets a generated WAV
through the file chooser; page B's engine reports a non-zero `inputLevel('boombox:<A>')`, and
`peer.info.boombox` is true on B. Then A presses `B` again and the flag clears.

Manual: the look at several distances, the first-person view next to the self-view, and the echo
check in §9.
