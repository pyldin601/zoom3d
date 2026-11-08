# Analytics Opt-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visitors who tick a switch keep one Amplitude device id across visits in the same browser; everyone else
stays storage-free.

**Architecture:** One localStorage key, `zoom3d.analytics`, holds the device id; present means opted in. A tiny store
reads and writes it; `telemetry/analytics.ts` starts the SDK with the stored id and exposes a switch (`statsSwitch()`)
that the lobby and the backtick console render as a checkbox. The SDK keeps `identityStorage: 'none'` and the
in-memory event queue.

**Tech Stack:** TypeScript, `@amplitude/analytics-browser` 2.47, Vitest (+ happy-dom for UI), Biome.

**Spec:** `docs/superpowers/specs/2026-11-08-analytics-opt-in-design.md`

## Global Constraints

- Key name exactly `zoom3d.analytics`; its value is the device id string. No other analytics storage, ever.
- Off by default. Someone who never ticks the box stores nothing (no key written, not even "off").
- SDK config otherwise unchanged: `identityStorage: 'none'`, `storageProvider: memoryStorage()`, no IP, no
  autocapture, remote config off, diagnostics off.
- Sessions are not continued across reloads (not a goal).
- Lobby copy, exactly: `Remember this browser for anonymous usage stats` followed by a link `privacy` to
  `/privacy.html` (opens in a new tab). Console row label: `Remember this browser`, under a heading `Usage stats`.
- Neither switch is shown when analytics is off (no `VITE_AMPLITUDE_API_KEY`).
- New event `analytics_consent { on: boolean }`, sent after the switch takes effect (so an opt-out goes under the
  fresh id).
- Storage access goes through `pageStorage()` and never throws (private mode, blocked storage).
- Code style: Biome, braced blocks, no "you/your" in identifiers or test titles.

## Review Focus

- **Blocked storage** (private mode, `pageStorage()` null or throwing): the switch can be toggled without errors and
  reads as off on the next load. Test in Task 1 and Task 2.
- **Opting in before the SDK chunk has loaded** (a fast click in the lobby): the id is saved once the SDK is ready.
  Test in Task 2.
- **Opting in then out before the SDK loads:** nothing is saved. Test in Task 2.
- **A stored value that isn't a usable id** (empty, or shorter than Amplitude's 5-character minimum, from a hand edit):
  ignored, as if absent. Test in Task 1.
- **The SDK chunk fails to load:** toggling does nothing and doesn't throw. Test in Task 2.

---

### Task 1: The consent store

**Files:**
- Create: `apps/web/src/telemetry/analytics-consent.ts`
- Test: `apps/web/src/telemetry/analytics-consent.test.ts`

**Interfaces:**
- Produces:
  - `export const ANALYTICS_KEY = 'zoom3d.analytics'`
  - `loadRememberedDeviceId(storage: Pick<Storage, 'getItem'> | null): string | null`
  - `rememberDeviceId(storage: Pick<Storage, 'setItem'> | null, deviceId: string): void`
  - `forgetDeviceId(storage: Pick<Storage, 'removeItem'> | null): void`

Follow `ui/name-store.ts`: every call swallows storage errors.

- [ ] **Step 1: Write the failing tests** (a `Map`-backed fake storage, as in `ui/name-store.test.ts`)
  - `round-trips the device id under zoom3d.analytics`: load → `null`; remember `'abcdef-123'`;
    `ANALYTICS_KEY === 'zoom3d.analytics'`; the map holds it; load → `'abcdef-123'`; forget → load `null` and the map
    has no key.
  - `ignores a stored value too short to be a device id`: map holds `''` → `null`; `'abcd'` → `null`; `'abcde'` →
    `'abcde'`.
  - `throwing or missing storage is tolerated`: each function with a throwing method and with `null` doesn't throw;
    loads return `null`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/telemetry/analytics-consent.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three functions in `analytics-consent.ts`; the minimum length is a named constant
  `MIN_DEVICE_ID_CHARS = 5` (Amplitude's `minIdLength` default).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add a store for the opted-in analytics device id"`

### Task 2: The analytics switch

**Files:**
- Modify: `apps/web/src/telemetry/analytics.ts` (header comment, `AnalyticsEvent`, `initAnalytics`, new exports)
- Modify: `apps/web/src/main.ts:11` (pass `pageStorage()`)
- Test: `apps/web/src/telemetry/analytics.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's three functions.
- Produces:
  - `initAnalytics(apiKey: string | undefined, appVersion: string | undefined, storage: Storage | null): void`
  - `export interface StatsSwitch { on: boolean; onChange(on: boolean): void }`
  - `statsSwitch(): StatsSwitch | null`: null when analytics is off or its SDK failed to load; `on` is whether the
    key holds an id right now (read at each call); `onChange` is `setStatsRemembered`.
  - `setStatsRemembered(on: boolean): void`
  - `AnalyticsEvent` gains `| { name: 'analytics_consent'; on: boolean }` (a new `// Privacy` group).

Behaviour:
- `initAnalytics`: if `loadRememberedDeviceId(storage)` returns an id, pass `deviceId: <it>` to `sdk.init`; otherwise
  no `deviceId` option (as today).
- `setStatsRemembered(true)`: if the SDK is ready, `rememberDeviceId(storage, sdk.getDeviceId())` (it returns
  `string | undefined`; save nothing for `undefined`); if it is still
  loading, remember the wish and do it right after `init`. Then `track({ name: 'analytics_consent', on: true })`.
- `setStatsRemembered(false)`: `forgetDeviceId(storage)`, cancel a pending wish, and if the SDK is ready
  `sdk.setDeviceId(crypto.randomUUID())`. Then `track({ name: 'analytics_consent', on: false })`.
- Analytics off or failed: both are no-ops.
- Rewrite the header comment: storage-free unless the visitor opts in, then exactly one key with the device id.

- [ ] **Step 1: Write the failing tests.** `vi.mock('@amplitude/analytics-browser', ...)` with `init`, `track`,
  `flush`, `setTransport`, `getDeviceId: () => 'memory-id-1'`, `setDeviceId` as `vi.fn()`s; in `beforeEach`,
  `vi.resetModules()` and import `./analytics` afresh (module state); `await vi.dynamicImportSettled()` after
  `initAnalytics`. Fake storage as in Task 1.
  - `starts with the remembered device id`: storage holds `'stored-id-1'` → `init` called with
    `expect.objectContaining({ deviceId: 'stored-id-1', identityStorage: 'none' })`.
  - `starts without a device id when none is remembered`: `init`'s options have no `deviceId` key.
  - `remembering saves the current id and reports consent`: after load, `setStatsRemembered(true)` → storage holds
    `'memory-id-1'`; `track` called with `('analytics_consent', { on: true })`; `statsSwitch()?.on === true`.
  - `remembering before the SDK loads saves the id once it has`: call `setStatsRemembered(true)` before
    `dynamicImportSettled` → storage empty; after → holds `'memory-id-1'`.
  - `remembering then forgetting before the SDK loads saves nothing`.
  - `forgetting removes the id and switches to a fresh one`: storage holds an id, after load
    `setStatsRemembered(false)` → key gone, `setDeviceId` called once with a string ≠ `'stored-id-1'`, `track` called
    with `('analytics_consent', { on: false })` after `setDeviceId` (check `mock.invocationCallOrder`).
  - `the switch is absent when analytics is off`: `initAnalytics(undefined, …)` → `statsSwitch() === null`, and
    `setStatsRemembered(true)` writes nothing.
  - `the switch is absent and inert when the SDK fails to load`: mock factory throws → after settle,
    `statsSwitch() === null`; `setStatsRemembered(true)` doesn't throw and writes nothing.
  - `blocked storage: toggling doesn't throw and reads as off`: storage `null` → `setStatsRemembered(true)` ok,
    `statsSwitch()?.on === false`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/telemetry/analytics.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `analytics.ts`; update `main.ts` to `initAnalytics(key, release, pageStorage())`
  (import from `./game/page`).
- [ ] **Step 4: Run** the test file, then `pnpm typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `git commit -m "Keep the analytics device id across visits for those who opt in"`

### Task 3: The lobby checkbox

**Files:**
- Modify: `apps/web/src/ui/lobby.ts` (`LobbyOptions`, `showLobby`)
- Modify: `apps/web/src/game/lobby-flow.ts:45` (pass `stats: statsSwitch()`)
- Modify: `apps/web/index.html` (a `.lobby .remember-stats` rule next to the other lobby styles: small, muted, like
  the invite row)
- Test: `apps/web/src/ui/lobby.test.ts`

**Interfaces:**
- Consumes: `StatsSwitch`, `statsSwitch()` from Task 2 (type-only import in `lobby.ts`).
- Produces: `LobbyOptions.stats?: StatsSwitch | null`.

- [ ] **Step 1: Write the failing tests** in `lobby.test.ts`, using its existing option helper:
  - `no stats checkbox without a switch`: `stats` absent → no `.remember-stats`.
  - `the stats checkbox is off by default, says what it does and links the privacy page`: `stats: { on: false, … }` →
    `.remember-stats` sits after the form; `textContent` is
    `Remember this browser for anonymous usage stats (privacy)`; the checkbox is unchecked; the link's `href` ends
    in `/privacy.html` and `target === '_blank'`.
  - `ticking it calls the switch at once, without joining`: click → `onChange` called with `true`, `onJoin` not called;
    click again → `false`.
  - `it shows as ticked when already remembered`: `on: true` → checked.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/ui/lobby.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement:** a `<label class="remember-stats">` with the checkbox, the copy, and ` (`, the link,
  `)`, placed after `error` and before the invite row; all text through `textContent`. Wire `lobby-flow.ts`.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Offer the usage-stats opt-in in the lobby"`

### Task 4: The console row

**Files:**
- Modify: `apps/web/src/ui/console-panel.ts` (`ConsolePanelOptions`, a `statsRow` like `lightingRow`)
- Modify: `apps/web/src/game/game.ts:70` (`stats: statsSwitch()` in the panel options, read each time it opens)
- Test: `apps/web/src/ui/console-panel.test.ts`

**Interfaces:**
- Consumes: `StatsSwitch`, `statsSwitch()` from Task 2.
- Produces: `ConsolePanelOptions.stats: StatsSwitch | null`.

- [ ] **Step 1: Write the failing tests** (add `stats: null` to the `options()` helper):
  - `no usage stats row without a switch`: `textContent` lacks `Usage stats`.
  - `the usage stats row shows the switch and changes it`: `stats: { on: true, onChange }` → an `h2` `Usage stats`
    after the lighting row, then a label `Remember this browser` with a checked checkbox; click → `onChange(false)`.
- [ ] **Step 2: Run** `pnpm --filter @zoom3d/web exec vitest run src/ui/console-panel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and wire `game.ts`.
- [ ] **Step 4: Run** the test file and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Let the console switch usage stats memory off again"`

### Task 5: Docs and a browser check

**Files:**
- Modify: `apps/web/public/privacy.html` ("What stays in your browser" and "Usage statistics")
- Modify: `AGENTS.md` (the "Telemetry privacy" bullet: storage-free unless opted in, one key)
- Modify: `docs/open-decisions.md` (D20's 2026-11-08 amendment: built, with the spec link; settle its open details
  as this plan did)
- Modify: `docs/alpha-launch-checklist.md` (tick the spec and build items)

- [ ] **Step 1: Privacy page.** Usage statistics: by default the id is forgotten on reload and nothing is stored; if
  the box is ticked, the random id is kept in local storage (`zoom3d.analytics`) so later visits count as the same
  visitor; the basis for that is consent; unticking it in the lobby or the console (`` ` ``) deletes it. Keep "No
  IP address, name or room link is included."
- [ ] **Step 2: AGENTS.md, D20, checklist** as listed above.
- [ ] **Step 3: Browser check.** Start the dev server with `VITE_AMPLITUDE_API_KEY=dev-dummy` (events are rejected
  by Amplitude; only the UI and storage matter). In the lobby: the box is unticked and `localStorage` has no
  `zoom3d.analytics`; tick → the key holds an id; reload → the box is ticked and `init` got that id (check via the
  network payload's `device_id`); join, open the console, untick → the key is gone. Without the env var, neither
  switch shows.
- [ ] **Step 4: Run** `pnpm exec biome check --write .`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. Expected: all green.
- [ ] **Step 5: Commit** `git commit -m "Document the usage-stats opt-in"`
