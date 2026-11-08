# Analytics opt-in: the same user across visits

*2026-11-08. Decision D20, amended 2026-11-08. Small change; short design.*

## Why

Analytics is storage-free today (D20): Amplitude's device id lives in memory, so every page load is a new user and
retention or returning-visitor numbers can't be measured. For the alpha the owner wants returning visitors counted,
for those who agree. Storing an id on the device for analytics needs opt-in consent (ePrivacy Art. 5(3)).

## Goals, non-goals, anti-goals

- **Goal:** a visitor who opts in keeps one Amplitude device id across visits in the same browser.
- **Non-goal:** continuous sessions across reloads. Each load may start a new Amplitude session (owner, 2026-11-08).
- **Non-goal:** EU data residency. It would mean a new Amplitude project and losing the history; Amplitude is under
  the EU-US Data Privacy Framework.
- **Anti-goals:** a banner, anything that blocks or slows joining, opted-in by default, any storage at all for
  someone who never opts in, names, room ids or IPs in events (unchanged).

## Approaches

- **Our own key holding only the device id (chosen).** The SDK stays `identityStorage: 'none'` with its in-memory
  event queue; at start it gets `deviceId` from our key when there is one. One key we own, one format, nothing else
  of Amplitude's on the device. Fits the owner's "session can be different, but the user id should be consistent".
- **Amplitude's own localStorage identity when opted in.** Also continues sessions across reloads, but writes several
  `AMP_*` keys whose format we don't own, and the setting can't change mid-visit anyway. Rejected: session continuity
  isn't wanted.
- **Cookieless server-side daily hash.** Same-day continuity at most, and needs IPs. Rejected in D20.

## Design

- **The choice and the id are one localStorage key**, `zoom3d.analytics`, holding the device id. Present means opted
  in; absent means not. Read through `pageStorage()` (`game/page.ts`); blocked storage means opt-in simply isn't
  remembered.
- **Start (`initAnalytics`):** if the key holds an id, `init` with `deviceId: <it>`; otherwise as today, with a random
  in-memory id. Everything else in the config is unchanged.
- **Opting in:** write the SDK's current device id to the key, so the events already sent in this visit (landing,
  party, lobby) belong to the same user. If the SDK hasn't loaded yet, write it once it has.
- **Opting out:** remove the key and give the SDK a fresh random device id (`setDeviceId`), so the rest of the visit
  can't be tied to the stored one.
- **Where:** a checkbox in the lobby, under Join, off unless the key is present: "Remember this browser for
  anonymous usage stats", with a link to `/privacy.html`. The same switch as a row in the room console. Neither is
  shown when analytics is off (no `VITE_AMPLITUDE_API_KEY`).
- **Event:** `analytics_consent { on: boolean }` when the switch changes, so the opt-in rate is visible. Add it to
  `AnalyticsEvent`.
- **Docs in the same change:** `privacy.html` (what is stored when opted in, consent as the basis for those
  visitors, how to withdraw), the analytics module's header comment, the telemetry line in AGENTS.md, and D20.

## Left to the builder

- Module boundaries (a small consent store next to `name-store.ts` and friends, or inside `telemetry/`).
- Exact lobby and console layout, following the existing controls.
- Tests: the store (present/absent/blocked storage), start with and without a stored id, opt-in before and after the
  SDK loads, opt-out replacing the id. Lobby and console wiring checked in the browser.
