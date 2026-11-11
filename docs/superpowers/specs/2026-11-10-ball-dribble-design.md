# Basketball dribble: design spec

Status: draft for owner review. Decision record: [open-decisions.md](../../open-decisions.md) D37 (to add when approved).
Builds on the ball (D26, `2026-10-23-ball-design.md`), its mind (D33), its drawn hops (D34) and kick scooters (D36).

Calls marked **(my call)** were made by the designer, not by the product owner, and can be overridden.

## 1. Intent

Pressing E next to the ball picks it up into a basketball dribble: the ball bounces between the floor and the player's
hand, and it goes wherever the player goes. It stays in front of where they look, so turning the view (the mouse)
swings it round with them, and walking carries it along. Today the ball can only be pushed and kicked, soccer-style;
this adds a hand-held way to play with it.

### Goals (owner)

- E near the ball starts a dribble.
- While dribbling the ball bounces floor ↔ hand and moves with the player: with their walking and with their turning.
- Everyone sees the ball at the dribbler's hand, bouncing, as they move.
- The ball's mind sleeps while held: no running off, no fear, and the vacuum leaves it alone.
- Ending it:
  - **E again:** let go. The ball drops and rolls on with the dribbler's motion.
  - **Space:** throw. Today's kick, the way the player faces, leaving from the hand.
  - **Someone else** kicking it (Space in reach) or walking into it knocks it loose: stealing.
- No dribbling on a scooter: on a scooter E always means stepping off. While dribbling, E always means letting go,
  even with a scooter in reach; a second E then mounts **(my call)**. The server refuses `ride` from a dribbler.
- Built as approach A (§3): the server marks the ball as held by one person.

### Non-goals

- Shooting at anything, hoops, scores, passing aimed at a person. The vision's "no game rules" still holds.
- A bounce the dribbler controls (harder, lower, crossovers) **(my call)**: one steady rhythm.
- The bounce in sync between screens. Each screen draws its own bounce; only where the ball is is shared **(my call)**.
- Bots dribbling or stealing. Bots never touch the ball (D26) and still don't.
- Drinking or using a held item while dribbling: a dribbler's held item is hidden on every screen, as a rider's is,
  never sent as `held: null`, and comes back on release **(my call)**.

### Anti-goals (a failure even if it works)

- The ball lags behind the hand or trails behind on a turn, on any screen.
- On the dribbler's own screen the ball waits for the server before it comes up, or snaps back after a let-go or throw.
- The ball ends up inside a wall, or is carried through one.
- Frame rate drops: no per-frame allocations, `pnpm bench:sprites` holds.
- A client can grab the ball from across the room, or move it anywhere but its own hand.

## 2. Behaviour

### 2.1 Starting

- E with the ball in reach (`BALL_KICK_REACH`, measured where it appears to the local player, as `scooter-ride.ts`
  measures scooters) asks the server to dribble. If a parked scooter is also in reach, E takes whichever is nearer
  (owner approved "nearest thing wins"). Riding, E only steps off.
- The server says yes if the asker is on foot, near enough (with the same latency slack as a kick), and nobody holds the
  ball. A ball another person dribbles can't be taken by E; it can only be knocked loose (§2.3) **(my call)**.
- The dribbler's own screen shows the ball in the hand at once (prediction, §4.2) and falls back if refused, like a
  kick waiting for its echo.

### 2.2 While held

- **Hold spot:** `HOLD_FORWARD_TILES = 0.5` ahead along the player's eye angle and `HOLD_SIDE_TILES = 0.2` to its right
  (the right hand), measured from the player's centre **(my call; tuned by playing)**. On foot the eye angle is
  `pose.angle`, which every peer already sends, so nothing new travels.
- **Walls:** if the hold spot would put the ball (radius 0.2) into a wall, it is pulled back along the line to the
  player's centre until it is clear **(my call)**. The player's centre is always clear, so this always ends.
- **Portals:** the ball is placed from the dribbler's pose after any crossing; a hold spot on the far side of a portal
  from the player is pulled back like a wall would pull it, so the ball never goes through a portal on its own **(my
  call)**.
- **Physics and mind** don't run on a held ball. Its velocity is the dribbler's, for sound and for the let-go. The
  vacuum and other bodies don't bounce it; another person's body touching it is a steal (§2.3).
- **Bounce (drawn only, like D34 hops):** a steady dribble with period `DRIBBLE_PERIOD_S = 0.5`, hand height
  `DRIBBLE_HAND_TILES = 0.45` (under the 0.85 lamps), fastest at the floor **(my call)**. It goes in
  `VoxelInstance.lift`, so shadows and the floor mirror already follow. Each floor touch plays the existing ball bounce
  sound from that screen's drawn ball, at a dribble level under voices **(my call)**.

### 2.3 Ending

| Way | Who | What the ball does |
|---|---|---|
| E | the dribbler | released at the hold spot with the dribbler's velocity; physics resumes, the mind starts again asleep (§2.4) |
| Space | the dribbler | released and kicked from the hold spot along the eye angle at `BALL_KICK_SPEED`, through `kickBallMind` like any kick |
| Space in reach | anyone else | a normal kick of the ball from where it is: it comes loose and flies |
| Walking into it | anyone else (people only), **moving** | a normal push: it comes loose and rolls |
| Leaving, or a dropped connection the server ends | the dribbler | let go, as E |

A steal by body needs the other person to be moving, as a push does today (the owner's "walking into it"). A
dribbler who walks into someone standing still, or squeezes past them in a narrow hall, keeps the ball **(my call)**.
| A server restart | — | the state file saves the ball where it is, not held |

A dropped connection the server is still holding open for a resume keeps the dribble, like a ride (`ridesNow`)
**(my call)**: the ball stays at the dribbler's last pose.

### 2.4 The mind while held **(my call)**

Owner: the mind sleeps while held. So on pickup the mind is set asleep and its timers stop; while held its mood is
`asleep` on the wire and on screen (no tremble, no cries). Picking it up is no kick: no `kickBallMind`, no cry. On a
let-go it starts asleep, fresh; on a throw it goes through `kickBallMind` like any kick. It does not go back to a mood
it had before the pickup.

## 3. Approaches (owner picked A)

- **A. The server holds the ball for the dribbler (picked).** One flag on the ball says who holds it; every screen
  places it from that person's drawn pose. Glued to the hand everywhere, no streaming, same pattern as a ridden
  scooter. Cost: a held state and its release paths on the server.
- **B. The dribbler's client streams ball positions.** Rejected: more traffic, the ball lags on other screens, and it
  breaks D26's rule that no client can teleport the ball.
- **C. A magnet force in the existing physics.** Rejected: the ball trails on turns and fights walls and its mind,
  the rubbery feel D26 names as its first anti-goal.

## 4. How it's built (approach A)

### 4.1 Wire and server

- `ObjectInfo` for the ball gets `heldBy?: string`, the dribbler's peer id; absent when loose. Its `x, y` while held is
  the server's hold spot (for late joiners and anything that reads raw positions), but clients draw from the pose
  (§4.2).
- New client messages: `{ type: 'dribble' }` to pick up and `{ type: 'release' }` to let go. A throw is the existing
  `kick` from the dribbler: the server sees the ball is theirs, releases it and kicks it from the hold spot.
- A refused `dribble` gets `{ type: 'dribble_refused' }`, as a kick gets `kick_refused`.
- `PROTOCOL_VERSION` 6 → 7 **(my call)**: an old tab would run its own prediction against a ball that moves with
  someone, and fight it.
- `Lobby`: the held state lives with the ball. `stepWorld` places a held ball at the dribbler's hold spot each tick
  (with wall and portal pull-back) instead of stepping it, and skips its mind. Steals are checked there: another
  connected person whose body overlaps the held ball, or a kick from anyone else, releases it first, then the touch or
  kick applies as today. The release paths in §2.3 (leave, expiry) clear `heldBy`; `ride` from a dribbler is refused.
- Hold-spot geometry is a pure shared function (`packages/shared/src/objects/ball/`), used by server and client alike.

### 4.2 Client

- **Dribbler's own screen:** `ball-prediction.ts` gets a held mode. While the local player holds it (asked for and not
  refused, or the server says so) the drawn ball is placed every frame at the local player's hold spot in the present,
  from `localPlayer.eye()`, never through interpolation. On let-go or throw it starts from that spot with the local
  velocity or kick, like today's local kick, and waits for the server's echo before easing.
- **Others' screens:** a ball held by someone else is placed every frame from that peer's drawn pose
  (`remote-world.ts`), like a ridden scooter is drawn from its rider. When `heldBy` clears, the ball goes back to the
  ordinary server-driven prediction.
- **Bounce:** a new drawn lift for the dribble (`game/ball-dribble.ts` or a mode of `ball-hop.ts`), replacing the hop
  while held. On release the ball falls from its current drawn height into the existing hop/rebound.
- **Input:** E goes through one chooser with three states: riding → dismount; dribbling → let go; on foot → the
  nearer of the ball and a parked scooter. Space while holding is the throw. The touch scooter button becomes a "use" button that also shows a ball
  icon when the ball is the nearer thing **(my call)**.
- **Hint:** the existing ride hint gets a dribble wording when the ball is the nearer thing **(my call)**.

## 5. Decided by the owner

- E near the ball starts it; the ball moves with walking and with turning the view.
- Approach A.
- Ending: E lets go, Space throws, others steal by kicking or walking into it.
- Mind asleep and vacuum ignored while held; no dribbling while riding; nearest thing wins for E.

## 6. Left to the builder

- Exact hold offsets, period, hand height and dribble sound level: tune by playing, starting from the values above.
- Where the held state lives in the server's ball bookkeeping, and the names of new functions and files.
- Tests: hold spot geometry and wall/portal pull-back, server start/refuse/release/steal/throw, protocol parsing, the
  prediction's held mode, and the dribble lift curve, all written failing first. Rendering checked in game.
- An e2e is optional **(my call)**: the server and prediction tests cover the logic.
