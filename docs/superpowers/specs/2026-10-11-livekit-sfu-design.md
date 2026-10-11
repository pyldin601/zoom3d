# Media through LiveKit (step 6b) — design spec

Status: draft, 2026-10-11. Decision record: [open-decisions.md](../../open-decisions.md) D1 (media topology) and D11
(hosting). Part of the path to 100+ person rooms: 6a deploy LiveKit (done), **6b switch media to it**, 6c subscribe
by visibility with simulcast, 6d scale and load test.

## 1. Intent

Move all audio and video from the peer-to-peer mesh to the LiveKit SFU already running on casa
(`wss://lk.pyldin601.xyz`), with **no visible change**: same faces, voices, boombox, speaking rings, up to 8 people.
6b only swaps the transport. Selective subscription (who you receive) and simulcast come in 6c.

### Goals
- Every participant uploads its tracks once, to LiveKit; LiveKit forwards them to everyone in the room.
- The game WebSocket keeps positions, names, avatars and rooms. It no longer relays WebRTC signalling.
- The existing e2e suite passes unchanged against a real local LiveKit: that is the proof of "same experience".
- One media path: the mesh and its signalling are deleted once LiveKit is green.

### Non-goals
- Subscribing by distance/visibility, simulcast, raising the 8-person cap (6c, 6d).
- Server-enforced subscriptions or per-track permissions.
- Supporting old open tabs across the cutover: they lose media until reloaded.

## 2. Architecture

```
browser ── ws (game: join/state/media/...) ──▶ zoom3d server ──┐ signs a LiveKit token per peer
   │                                                           │
   └── LiveKit signalling + WebRTC (face, mic, boombox) ──▶ LiveKit SFU (casa, zoom3d namespace)
```

- `MediaTransport` (`apps/web/src/media/mesh.ts`) stays the seam: `call.ts` only talks to it. 6b adds
  `apps/web/src/media/livekit.ts`, a second implementation, then removes the mesh.
- LiveKit room name = zoom3d room id (22-char secret). Participant identity = zoom3d peer id.

## 3. Server

- Env: `LIVEKIT_URL` (public URL handed to clients), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
  - In production (`NODE_ENV=production`) all three are required; the server refuses to start without them.
  - Otherwise they default to LiveKit's dev values: `ws://localhost:7880`, `devkey`, `secret`.
- Token: `livekit-server-sdk` `AccessToken`, identity = peer id, grants `{ room, roomJoin, canPublish,
  canSubscribe }`, TTL 6 h. A fresh token is minted on every `welcome` (first join, resume, new identity).
- Protocol:
  - `welcome` gains `livekit: { url: string; token: string }` and drops `iceServers`.
  - The `signal` message (both directions), `SignalPayload`, `IceServer` and `apps/server/src/ice.ts` (STUN/TURN
    env) are removed.
- Production: the server Deployment reads the three env vars from the `livekit-keys` SealedSecret (already in the
  `zoom3d` namespace) plus `LIVEKIT_URL=wss://lk.pyldin601.xyz`.

## 4. Client transport (`media/livekit.ts`, `livekit-client`)

- `createLiveKitTransport(opts)` implements `MediaTransport`. Options: `url`, `token`, `localStream`,
  `onRemoteStream`, `onRemoteBoombox`, and an injectable `Room` constructor for tests.
- Connect on creation with `autoSubscribe: true` (6b receives everyone, like the mesh) and `adaptiveStream: false`,
  `dynacast: false` (both would act on our hidden `<video>` elements, not on what is drawn).
- Published tracks, matched by **name**, never by order:

  | name | source | from | encoding |
  |---|---|---|---|
  | `face` | Camera | the framer's send track (canvas, or raw camera while hidden) | 350 kbps max, no simulcast |
  | `mic` | Microphone | the local mic track | Opus default, DTX on |
  | `boombox` | ScreenShareAudio | the boombox track, while on | 128 kbps music, DTX and RED off |

- Our own `MediaStreamTrack`s are published as user-provided tracks, so LiveKit never stops or re-acquires them:
  `LocalMediaController` keeps owning every local track (AGENTS gotcha).
- `setVideoTrack` / `setAudioTrack` use `replaceTrack` on the existing publication, so camera on/off and hidden-tab
  swaps never republish. `setBoomboxTrack(track)` replaces the boombox track if published, publishes it if not, and
  unpublishes on `null`.
- Remote side: on `TrackSubscribed`, a participant's `face` and `mic` tracks join one `MediaStream` per participant,
  passed to `onRemoteStream(identity, stream)` (again whenever the stream gains a track). `boombox` gets its own
  stream for `onRemoteBoombox`. The rest of the pipeline is unchanged: remote elements stay muted but playing,
  and the spatial engine is the only audible path.
- `connect` / `disconnect(peerId)` become no-ops for subscription (6c uses them); `close()` disconnects the room.
- `stats(peerId)` sums `bytesReceived` of that participant's subscribed tracks (`getRTCStatsReport`), split into
  face+mic and boombox, keeping the e2e hooks.
- Reconnection inside a session is LiveKit's. When the game session's identity changes, `call.ts` already tears the
  transport down and builds a new one from the new `welcome`.

## 5. Local development and tests

- LiveKit runs natively from Homebrew (`brew install livekit`), never Docker.
- `pnpm dev` starts `livekit-server --dev` (port 7880, keys `devkey`/`secret`) next to the server and web app.
- Playwright starts its own instance on separate ports (7890 signal, 7891 TCP, 7892 UDP) and passes
  `LIVEKIT_URL=ws://localhost:7890` to its server, so e2e never touches `pnpm dev`'s instance.
- CI is unchanged: `checks.yml` runs unit tests only; e2e stays local.
- Unit tests:
  - Token claims: identity, room, grants, expiry; verify the signature with the secret.
  - Protocol validation of `welcome.livekit`.
  - Production env requirement.
  - Transport against a fake `Room`: names and options of published tracks, `replaceTrack` without republishing,
    boombox publish, replace and unpublish, per-participant stream assembly, boombox routing, stats split.
- E2E: the existing suite unchanged, against local LiveKit.

## 6. Rollout

1. Merge; CI builds `sha-<x>` images.
2. Servers repo, one commit: server env (`LIVEKIT_URL` plus `envFrom` the `livekit-keys` secret) and both image tags.
3. Verify on prod: two clients (one on mobile data) see and hear each other through LiveKit. LiveKit logs show the
   room and its participants.
4. Rollback: revert that servers commit (the previous images still have the mesh).

## 7. Risks

- **Hairpin UDP:** TURN-only clients can't reach this SFU (D11). Clients on UDP-blocked networks use ICE/TCP 7881.
  Only 443-only networks fail, as they do today without TURN.
- **Home uplink and CPU** are irrelevant at ≤ 8 people. They are what 6d measures.
- **`livekit-client` bundle size:** it adds a sizeable dependency to the web bundle (measure it in the cutover
  task). Acceptable for a meeting app; the mesh code goes away.
