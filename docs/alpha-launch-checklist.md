# Alpha launch checklist

*Drafted 2026-11-08.* Alpha here means: the public link at https://zoom3d.pyldin601.xyz is handed to invited
testers (small groups, up to the vision's ~8 people per room), with a clear "alpha" label and a way to send feedback.
Tick items as they're done; anything decided goes into [open-decisions.md](open-decisions.md) as usual.

## 1. Blockers: legal and trust

- [ ] **Map provenance.** The v1 map was converted from a Wolfenstein-style level image (D9,
  `docs/assets/map-reference.png`). Confirm its layout isn't a copy of a real Wolfenstein 3D level, or replace it with
  an original map before anyone outside friends sees it.
- [ ] **Licence.** The repo is public with no `LICENSE`. Pick one (or state "all rights reserved") and add it.
- [ ] **Assets audit.** Every sound, texture, font and model in `apps/web` is ours or carries a licence that allows it;
  list third-party ones (MediaPipe model included) in a credits/notice file.
- [ ] **Privacy page.** `public/privacy.html` matches what Sentry, Amplitude, logs and metrics actually collect
  today (D20), names who runs the service and how to reach them, and says media goes through our LiveKit SFU and is
  never recorded.
- [ ] **Terms / acceptable use.** One short page: alpha, no guarantees, don't abuse others, we may close rooms.

## 2. Safety in rooms

A room link is its only key (D8), so anyone with it can walk in with a camera on.

- [ ] Decide what a participant can do about an unwanted guest at alpha (mute them locally, hide their face, leave
  and start a new party). Ship at least local mute + hide, or write down why not.
- [ ] Rate limits and `MAX_PEERS` hold under a scripted join flood (one IP, many tabs).
- [ ] `?bots=N` is fine on prod (`MAX_BOT_ROOMS` caps it); confirm the cap and that bots can't be left running.

## 3. Browsers and devices

- [ ] **Chrome / Edge desktop:** full pass (lobby, join, faces, voice, every item, portals, scooters, reconnect).
- [ ] **Firefox desktop:** R1 echo check on speakers, faces, voice, 60 fps target (spec success criterion; still open
  from M5).
- [ ] **Safari macOS and iOS:** best-effort (R3). Join works, or a clear "use Chrome" message instead of a broken room.
- [ ] **Android Chrome:** touch mode pass (`e2e/mobile.spec.ts` covers layout, not real hardware).
- [ ] Unsupported browser / no WebRTC / no camera / permission denied: each shows a readable message (spec §10 error
  states, M5).
- [ ] Device pickers for camera, mic and output work and survive a device being unplugged (M5).
- [ ] 60 fps on a mid-range laptop with 8 real participants (vision success criterion), measured, not modelled.

## 4. First visit

- [ ] Landing page says "alpha", what the thing is, and how to give feedback.
- [ ] **Onboarding, stage 1** (needs a spec): a short guided first minute, each step done by doing it, skippable,
  shown once per visit (no storage, or strictly-necessary storage only), with touch-mode equivalents:
  - [ ] Camera capture: see one's own framed face and confirm it looks right.
  - [ ] Turn around: mouse (or arrows / drag on touch).
  - [ ] Movement keys: WASD / arrows (the touch stick).
  - [ ] Camera and mic on/off: where the toggles are and what others see and hear when off.
- [ ] Later stages, not for alpha unless asked: items (1–9), E to ride, Y portals, automap.
- [ ] Spawn doesn't leave newcomers lost (2026-10-16 walk-through: spawned facing a wall, a minute to find the other
  person). Spawn near people, facing them, or decide it's fine for alpha.
- [ ] Feedback channel exists and is linked in the game (form, email, or GitHub issues), with Sentry user feedback
  optional.

## 5. Operations

- [ ] **Alerts.** Today it's dashboards only, no Alertmanager. At minimum: an external uptime check on the site,
  `/ws` and `wss://lk.pyldin601.xyz`, notifying a phone.
- [ ] **Sentry** issues triaged to zero before launch; alert rule on new issues in web and server.
- [ ] **Returning visitors in analytics.** Today analytics is storage-free (D20): every visit is a new Amplitude
  device, so retention can't be measured. Keeping an id in the browser across visits needs **opt-in consent**
  (ePrivacy Art. 5(3): analytics isn't strictly necessary; the existing name/lighting storage can't be reused for it).
  *Decided 2026-11-08 (D20 amendment):* an opt-in toggle in the lobby, off by default; on, Amplitude keeps its device
  id in localStorage. Withdrawable from the room console; decliners stay storage-free as today.
  - [ ] Spec (open details listed in D20).
  - [ ] Build it, with `privacy.html` and AGENTS.md updated in the same change.
- [ ] **Uplink.** The 100-person test left uplink unmeasured; measure it with a few real rooms of 8, faces on.
- [ ] **Restart drill.** Deploy during a live room: people reconnect into their places (D35), the state file restores
  the vacuum, ball and scooters.
- [ ] **Rollback.** One-line recipe written down (revert the tag bump in the servers repo) and tried once.
- [ ] **Home hosting.** Decide what happens on a power or ISP outage (accept downtime and say so on the landing page,
  or a status note).
- [ ] **Public IP change.** LiveKit's run script restarts on a new IP; confirm TURN/TLS and TCP 7881 fallback still
  work afterwards, from mobile data.
- [ ] Capacity note: how many simultaneous rooms of 8 the node takes before CPU or uplink runs out.

## 6. Release hygiene

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm e2e` green on the launch commit.
- [ ] Open PRs settled: PR 130 (eye adaptation, postponed by the owner) stays out; the ball rewind/bodies spec stays
  parked.
- [ ] Tag the launch commit (`v0.1.0-alpha`) so CI pushes a semver image, and pin casa to it.
- [ ] `PROTOCOL_VERSION` and `LobbySnapshot` version recorded in the release notes, so later breaking changes are
  deliberate.
- [ ] README: what it is, alpha status, how to run locally, licence.

## 7. Launch day

- [ ] Fresh deploy, smoke test from two networks (home Wi-Fi + mobile data) with faces and voice.
- [ ] Grafana `zoom3d` dashboard and Sentry open while the first testers join.
- [ ] Invite the first group; collect feedback after the session.
- [ ] Write up what broke and what people asked for; feed it into [ideas.md](ideas.md) or new decisions.
