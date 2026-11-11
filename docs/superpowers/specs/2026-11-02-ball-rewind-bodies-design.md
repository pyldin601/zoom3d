# Ball: kicks that land where they were aimed, and other players' bodies

Follows the ball spec (`2026-10-23-ball-design.md`, D26). Builds on PR 132 (the push drift limit), which isn't merged yet.

## Why

The kicker and the server can disagree about the ball, and the client corrects the difference later, sometimes with a
visible jump. Two sources of that disagreement are left:

- A kick lands on the server's ball as it is when the message arrives, not where the kicker saw it.
- The client simulates only the local player's body, so a bounce off anyone else is a surprise. This is inferred from
  the 5-minute run traces, not proven.

The owner chose to try these two before deciding on replaying inputs (the bigger change).

## Goals

- Fewer jumps and fewer refused kicks in the 5-minute run than PR 132's result (709 kicks, 3 jumps over 0.6 tiles, 1 over
  1.5 tiles, 28 refused), with no jumps for a watcher.

## Non-goals

- Replaying the local player's touches in place of the hold. Decided after this run.
- The vacuum as a client-side body. Its kicks still arrive in server states.
- Bots, which the server's ball ignores too.
- Cheat resistance. The rewind is bounded, and there are no game rules to protect.

## Anti-goals

- Rewinding must never erase another person's accepted kick.
- `portals: null` keeps its results; with portals on, both parts go through `apparentPosition` like existing contacts.
- No allocations per frame on the client. The server's history is a fixed ring per ball.

## Approaches: which moment a kick is aimed at

1. **The client names what it saw (chosen by the owner):** the kick says which ball state it last received and how far
   past that state its ball was showing. Accurate per kick, and needs no shared clock.
2. **The server measures ping:** no message change, but it pings every 10 s, so the figure goes stale, and it can't see
   how far ahead the client shows the ball.
3. **The client sends the position it saw:** simple, but the server would have to check a position it can't trust, so
   it isn't less work.

## Design

### Rewinding a kick (server, `Lobby.kick`)

- `KickMessage` gains optional `seen` (the `seq` of the last ball state received) and `aheadMs` (the ms the client's
  ball was past that state: `LATENCY_S` plus the time since it arrived). Optional, so no `PROTOCOL_VERSION` bump: a tab
  without them gets no rewind.
- Each ball keeps a fixed ring of states with their server times, about 300 ms deep (`KICK_REWIND_MS`), written when
  `stepBalls` sends a state and when a kick lands.
- The aimed moment is the time of state `seen` plus `aheadMs`. It is clamped to the last 300 ms, never later than now,
  and never before the room's last accepted kick. An unknown `seen` counts as the oldest allowed moment.
- The server takes the newest recorded state at or before that moment and advances a scratch copy to it. It checks reach
  against the kicker's latest pose, kicks the copy, advances it to now with the room's current bodies, and only then
  writes it to the real ball.
- A refused kick changes nothing.
- The reach allowance goes back to `KICK_SLACK_TILES` alone: `KICK_SEEN_LATE_S` is removed, since the rewound ball is
  already where the kicker saw it. The gap check and `kick_refused` are unchanged.

### Other players' bodies (client, `ball-prediction.ts`, `room-loop.ts`)

- `step` also takes the other people's bodies. They collide with the drawn ball only; the copy of the server's ball
  stays bodyless, since it already holds everyone's touches.
- Each body uses the peer's newest received pose (`buffer.latest()`), not the 150 ms delayed pose it is drawn at. Its
  velocity comes from its recent poses. Through portals it goes through `apparentPosition`, like the local player's.
- Only the local player's own touches extend the hold.
- Bounces off these bodies play the local bounce sound, as bounces on the local ball already do.

**Known tradeoff:** a ball can bounce off a walking avatar about 0.45 tiles before the avatar is drawn there. That is
the price of putting the bounce where the server will.

## Testing

- Failing tests first: protocol round trip; lobby rewind (lands where seen, bounded to the window, never past another's
  kick, refused against the rewound ball, no fields means no rewind); prediction bouncing off another body.
- Repeat the 5-minute run with the new client code. That needs the server deployed first, or a local server: the rewind
  can't be measured on prod until it ships. The owner decides which.
- `pnpm e2e` before the PR.

## Left to the builder

- The ring's exact size and fields, how the kick fields reach `room.ts`, and how peers' velocities are read.
- How a peer in reconnect grace is treated, matching the server, which ignores peers with no connection.
