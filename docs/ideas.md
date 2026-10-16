# Ideas

Parked ideas: not decided, not scheduled. When one is picked up it goes through brainstorming into a spec in
`docs/superpowers/specs/` and a decision in [open-decisions.md](open-decisions.md), and leaves this page.

## Shared screen (cinema)

*Parked 2026-10-16, mid-brainstorm.* It would overturn the [vision](vision.md)'s "screen sharing" non-goal.

One person shares a browser tab, window or screen, with its audio, and everyone watches it on a screen in the wood room
and hears it from there. Encoding is the browser's job: a video file on disk is shared by opening it in a Chrome tab.

### Settled

- **Starting.** A hotkey opens the browser's share picker (`getDisplayMedia`). The picked surface's video, and its
  audio when ticked, are published to LiveKit as named tracks next to `face` and `mic`.
- **One share per room.** Pressing the hotkey while someone shares opens no picker; it shows "Roman is already sharing
  the screen" in a new stack of messages over the view (HTML is fine for messages, not for the picture).
- **Placement.** A marker in the map places a screen object: a world object like the vacuum, not a peer. In `LEVEL1` it
  stands centred in front of the wood room's north wall (the wall spans columns 29–39, so column 34, row 1).
- **Shape.** A flat panel with a fixed facing (south in the wood room), not a billboard. Full wall height (one tile);
  the width follows the share's aspect ratio, centred (16:9 is 1.78 tiles), and changes with it.
- **Drawing.** The raycaster draws it, depth-tested against walls and discs like a thin wall (Wolfenstein's doors).
  No HTML overlay.
- **Sound.** It comes from the screen's position, spatialised like a voice: distance, pan, muffling through walls.
- **The sharer** may be in the game or in the shared tab while it plays; both must work.

### Proposed, not yet confirmed

- Hotkey `V` (B, M, C, Tab, `` ` `` and 1–3 are taken).
- Everyone gets "Roman started sharing" / "stopped sharing" in the stack; newest at the bottom, each fades after
  about 5 s, top-left of the view. The existing bottom banner stays where it is.
- A share stops on the hotkey again, the browser's own "Stop sharing" bar, or the sharer leaving; the lock frees.
- One marker character; the panel faces away from the wall it stands against, and it is solid for movement, so nobody
  stands behind it.
- The picture shows at full brightness whatever the lighting mode, and doesn't light the room. Nobody sharing: a dark
  panel.
- Receive the video only while the screen is in view and the audio within hearing range, like faces and voices (6c).
- Picker options: `selfBrowserSurface: 'exclude'` (no sharing the game into itself) and
  `CaptureController.setFocusBehavior('no-focus-change')` (the sharer stays in the game after picking).
- The sharer sees their own share on the wall from the local track, and hears the source tab directly (no
  `suppressLocalAudioPlayback`); the game never plays your own share back to you.
- Video at 720p, 30 fps (films need motion; the wall never shows more). Audio as the boombox: mono Opus, 128 kbps.

### Facts found

- Walls are one tile tall, the frame is 640×360 with a 66° FOV, so a wall is about 493 / d px tall at d tiles. From the
  back of the wood room (about 6.3 tiles) a 16:9 screen is about a fifth of the view's width; from 2.6 tiles it reads
  like a TV seen from the couch.
- Faces float at mid-wall height, so anyone standing in front of the screen covers the middle of the picture.
- Audio from `getDisplayMedia`: tab audio in Chrome and Edge on every OS; system audio on Windows and, from Chrome 141,
  macOS 14.2+. Firefox and Safari share the picture only. Mobile browsers can't share at all (they can watch).
- Streaming services with DRM (Netflix, Disney+) capture as black. YouTube, Twitch and local files work.

### Risks and open questions

- Echo: a sharer on speakers puts the film into their mic, so the room hears it twice, late. Headphones avoid it; check
  what Chrome's echo canceller does with another tab's audio.
- The frame budget: sampling the video per column must not allocate in the hot path.
- Wire changes: the lock messages, whether `PROTOCOL_VERSION` needs a bump, a sharer reclaiming the lock on resume, and
  the lock (but not the LiveKit track) being lost on a server restart.

Next step: confirm the proposals, write `docs/superpowers/specs/<date>-shared-screen-design.md`, record D25 and change
the vision's non-goal.

## Other ideas from the 2026-10-16 walk-through

Notes from a visit to a live room: the spawn faced a wall in the far south room and finding the other person took
about a minute and the automap; the hub was nearly black and the wood room big and empty; a listen-only visitor could
only walk and raise a drink.

- **Kickable ball** with goals in the wood room: a server-stepped world object on the vacuum's stack.
- **Tag or hide-and-seek**: the maze, spatial audio and wall muffling let you hear the seeker coming.
- **Rooms with a purpose**: a bar counter, a lounge, a dance floor in the pillared east hall whose lights follow the
  boombox; light the hub.
- **More gestures**: wave, dance, clap; a clink sound when two people cheers face to face.
- **Text bubbles** over the disc for a few seconds, for people without a mic.
- **The first minute**: spawn near people and facing them; click the automap to ping "come here".
- **Bigger bets** that cross the vision's non-goals: sliding doors for private side rooms, graffiti on walls, a room
  that stays around as "our place".
