# Server fan-out (step 6d) — design spec

Status: draft, 2026-10-11. Decision record: [open-decisions.md](../../open-decisions.md) D21. Follows
[6c, dynamic subscription](2026-10-11-dynamic-subscription-design.md). The user skipped the design questions and
asked for this document directly, so every choice below is the author's call unless D21 already fixed it.

## 1. Intent

After 6c, media scales with what each person can see and hear. The game socket still doesn't: the server relays
every accepted move as its own `peer_state` to everyone else in the room. Measured on casa with 100 bots: ~1,000
messages and ~1 Mbps per client, ~126 bytes per message, 700 messages out per message in. 6d makes the game socket
scale the same way media now does, so a room can hold 100+ people.

### Goals
- **Bounded fan-out:** each client gets at most one state message per server tick, carrying only the people it needs,
  nearby people at full rate and distant ones at a low rate.
- **Small joins:** the `welcome` no longer carries avatar pictures.
- **Rooms of 100+:** the people cap goes up, and every person gets a distinct colour.
- **Readable crowds:** name labels only for people near you.

### Non-goals
- Server-enforced visibility (a modified client may still learn everyone's position; positions aren't secret).
- Binary encoding, deltas or compression of state (JSON with absolute, rounded poses is enough at these sizes).
- Changes to media (6c), movement rules, or what clients send (`state` at up to 15 Hz stays as is).
- The load test itself (next step, D21).

### Anti-goals (a failure even if it technically works)
- Nearby people moving less smoothly than today.
- A lost or late message leaving someone stuck in the wrong place for more than one update.
- Old open tabs silently showing frozen people after the deploy.

## 2. State fan-out

### 2.1 Server tick
- One timer, `FANOUT_TICK_MS = 66` (15 Hz, the clients' own send rate), replaces per-move relays. Bots move on it too
  (today's separate 10 Hz bot timer goes: bots step every fan-out tick, at the same speed per second).
- `Lobby.state()` still validates each move (plausibility, corrections unchanged) and stores the pose, but sends
  nothing. Each peer gets a `poseVersion` counter, bumped on every accepted move and every bot step.
- On each tick, for every connected person P in a room, the server collects every other peer Q (people and bots)
  whose pose changed since it was last sent to P, and includes Q when either:
  - **near:** Q is within `NEAR_TILES = 16` tiles of P (straight-line distance, walls ignored), or
  - **due:** at least `FAR_INTERVAL_MS = 500` has passed since Q was last sent to P.
- The selected poses go out as **one** `peers` message to P, or nothing when the list is empty.
- Per recipient, the server remembers per peer the last `poseVersion` and time sent. That state is dropped when either
  side leaves, and reset on (re)welcome, since the welcome carries everyone's current pose.

### 2.2 Message
```ts
{ type: 'peers'; s: [slot: number, x: number, y: number, angle: number][] }
```
- `slot` is a small integer the server gives each peer in a room (`PeerInfo.slot`, sent in `welcome` and
  `peer_joined`), so the hot message doesn't repeat 16-character ids. Slots are never reused within a room's
  life (a counter), so a late batch can never move the wrong person.
- `x`, `y` are rounded to 0.01 tile; `angle` to 0.001 rad. One entry is ~25 bytes.
- Expected: someone in a 100-person crowd gets ~15 messages/s of up to ~100 entries, ~2.5 KB each in the worst
  case (everyone near and moving), against ~1,000 messages/s today. Far peers cost ~2 entries/s each.
- Events stay as they are, sent once when they happen: `peer_joined`, `peer_left`, `peer_media`, `peer_held`,
  `peer_drink`, `peer_cheers`, `peer_boombox`, `correction`, `error`. `peer_state` is removed from the protocol.

### 2.3 Client
- The session applies each entry like a `peer_state` today: it updates the peer's pose and pushes a snapshot into its
  interpolation buffer. Unknown slots are ignored. There is no per-entry `seq`: the socket is ordered.
- **Interpolation follows each peer's update rate.** Today every peer is drawn `INTERP_DELAY_MS = 100` in the past.
  A far peer updated every 500 ms would then sit still and jump. So each peer gets its own delay: about 1.5× the
  interval between its recent updates, clamped to 100–750 ms, and eased over ~0.5 s when it changes so someone
  crossing the 16-tile line doesn't visibly jump. Near peers stay at 100 ms, exactly as smooth as today.

## 3. Avatars over HTTP
- **Join is unchanged:** the client still sends its picture once, as a JPEG data URL (≤ 12 KB), in `join`.
- The server keeps pictures in an in-memory store keyed by content: `avatarId` = the first 22 characters of the
  base64url SHA-256 of the data URL. People with the same picture share an entry; an entry is dropped when no peer in
  any room uses it.
- `PeerInfo.avatar` becomes that id (or `null`) in `welcome` and `peer_joined`. A welcome for 100 people with pictures
  drops from ~1.2 MB to a few KB.
- **`GET /avatar/<avatarId>`** on the game server returns the JPEG (`image/jpeg`, `Cache-Control: public,
  max-age=31536000, immutable`), or 404 for an unknown id. Content-addressed: the URL only exists for a picture
  someone in a room is using, never reveals who, and can be cached forever.
- **Routing:** `/avatar/` is routed to the game server like `/ws`: a Traefik route in the servers repo, plus the same
  location in the web image's nginx template as a fallback. Not logged with room ids (the URL has none).
- The client loads `/avatar/<id>` as an `<img>` where it loads the data URL today (`createFace`'s `avatar`); until it
  decodes the face shows initials, as today. Same-origin, so drawing it on the face canvas stays untainted.
- **Restart snapshot:** peers keep their picture as a data URL in the snapshot, as today, so `LobbySnapshot` stays at
  version 1; `restore()` rebuilds the store.

## 4. Rooms of 100+
- **Cap:** `MAX_PEERS` goes from 8 to **128** people (bots still don't count). The "room is full" text reads the
  constant instead of saying 8. To revisit after the load test.
- **Colours:** the first 8 people still get today's `PEER_COLORS`, in order. After that, colours are generated: the
  golden-angle hue sequence (137.5° apart) at fixed, saturated settings, as `#rrggbb`, skipping any colour a present
  person already has. Bots keep their muted greys, so people still stand out.
- **Name labels:** drawn only for people within `LABEL_TILES = 10` tiles (still only when visible, with the mute icon).
  On the automap, everyone keeps a dot, but only people within the same 10 tiles get their name.

## 5. Deploy and old tabs
- `join` gains `v: 2` (`PROTOCOL_VERSION`). The server answers a join without it (every tab opened before this deploy)
  with error `invalid_room` and closes. Old clients treat that as fatal and show "Couldn't join this room", so an old
  tab asks for a reload instead of showing frozen people.
- For future bumps, a new error code `outdated` with the text "zoom3d was updated: reload the page" is sent to clients
  that do send a `v` lower than the server's; it is fatal in new clients.
- One rollout updates both images and the servers repo's `/avatar/` route together.

## 6. Observability
- `zoom3d_messages_sent_total{type="peers"}` and `zoom3d_bytes_sent_total{type="peers"}` replace `peer_state`. The
  Grafana panels for messages and bytes sent pick up the new type without changes.
- A histogram of entries per `peers` message (`zoom3d_peers_batch_entries`), to see how much the tiers save.

## 7. Testing
- **Lobby (unit):**
  - a move is not sent at once but on the next tick, batched with others;
  - near peers every tick, far peers at most every 500 ms;
  - unchanged poses are never resent;
  - bots go out the same way;
  - rounding;
  - slots are unique and never reused;
  - a resume or rejoin gets a fresh welcome and tracking.
- **Avatars (unit):** id = hash prefix; shared entries and dropping the last reference; welcome carries ids; snapshot
  round-trip; `GET /avatar/<id>` with headers and 404.
- **Protocol:** `peers` parsing (bad entries dropped), `slot` and avatar id in `PeerInfo`, `v` in `join`, `outdated`.
- **Client:** batches update poses and buffers; per-peer delay adapts and eases; labels and automap names only nearby;
  generated colours are valid, distinct and skip used ones.
- **E2E:** the existing multiplayer, bots, avatar and faces specs keep passing; one new check that an old-style join
  (no `v`) gets `invalid_room`.
- **Measure on casa:** with `/?bots=100`, messages/s and bytes/s per client before (~1,000 msg/s, ~1 Mbps) and after.

## 8. Left to the builder
- Code layout (e.g. a separate fan-out module beside `Lobby`), data structures for per-recipient tracking, and the
  exact easing curve of the interpolation delay.
- The colour generator's saturation and lightness, as long as colours are distinct, readable on the walls and not
  grey.
