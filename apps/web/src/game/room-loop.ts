// The room's frame: the local player steps, then the ball the client predicts, everyone else and the world objects are
// placed and heard, the view and the HUD are drawn, then the subscription picks whose media to receive. While the tab is hidden rAF stops, so a timer
// keeps the sound and the subscription going instead.
import {
  type Apparent,
  BALL_KICK_REACH,
  type BallBody,
  type GameMap,
  imagePosition,
  JUMP_TILES,
  PLAYER_RADIUS,
  type PlayerState,
  type Point,
  type Portals,
} from '@zoom3d/shared';
import { ownLoad } from '../audio/scooter-sounds';
import { HIDDEN_TICK_MS } from '../audio/ticker';
import type { Input } from '../input/keyboard';
import { createSubscription } from '../media/subscription';
import { ownAvatarShown, type RoomScene, renderHud, renderView } from '../renderer/frame';
import type { NameLabel } from '../renderer/labels';
import { createLightWave } from '../renderer/light-wave';
import type { Lighting } from '../renderer/lighting';
import { BALL_MODEL, createBallRoll, recolourBall, rollBy } from '../renderer/models/ball';
import { createBend } from '../renderer/slow-light';
import { showCountdown } from '../ui/portal-countdown';
import { litReflections, type RenderMode } from '../ui/render-settings';
import { type StatusLine, statusText } from '../ui/room-status';
import { createApparentWorld, placeOwnLabel } from './apparent-world';
import type { FrameRateMeter } from './frame-rate';
import { createTrail, type SeenLight } from './light-delay';
import { createLightTimeline } from './light-timeline';
import type { LocalPlayer } from './local-player';
import { createOwnMotion } from './own-motion';
import { portalPulse } from './portal-pulse';
import type { SequenceCues } from './portal-sequence';
import { createRemoteWorld, type PeerMedia } from './remote-world';
import { isConnected, type Room } from './room';
import { ridesNow } from './scooter-ride';
import type { Screen } from './screen';
import { chooseUse, type UseChoice, type UseState } from './use-key';

export interface RoomLoopOptions {
  map: GameMap;
  textures: Uint32Array[];
  localPlayer: LocalPlayer;
  input: Input;
  screen: Screen;
  hud: CanvasRenderingContext2D;
  /** Where the portal sequence's countdown shows. */
  ui: HTMLElement;
  frameRate: FrameRateMeter;
  statusLine: StatusLine;
  room(): Room | null;
  renderMode(): RenderMode;
  /** The speed of light in tiles/s while the console's slow light look is on (D39), else null. */
  slowLight(): number | null;
  roomLighting(): Lighting | null;
  showMap(): boolean;
  /** Every frame: whether the local player can kick the ball (for the touch kick button). */
  ballInReach(inReach: boolean): void;
  /** Every frame: whether a parked scooter is in reach on foot, and whether the local player rides one. */
  useState(choice: UseChoice | null): void;
}

export interface RoomLoop {
  frame(dt: number): void;
  whileHidden(): void;
}

export function createRoomLoop(o: RoomLoopOptions): RoomLoop {
  const { localPlayer, screen } = o;
  const world = createRemoteWorld();
  const subscription = createSubscription();
  const apparentWorld = createApparentWorld();
  /** The remote things (people, world objects and portal hums) with their places, reused from frame to frame. */
  let apparent: ReadonlyMap<string, Apparent> = new Map();
  const things: { id: string; x: number; y: number }[] = [];
  /** Where each portal doorway's hum plays from, reused from frame to frame. */
  const humSources = new Map<string, { x: number; y: number }>();
  const peerMedia: PeerMedia = {
    faceOf: (id, lateMs) => o.room()?.call.faceOf(id, lateMs) ?? null,
    speaking: (id) => o.room()?.audio.speaking(id) ?? 0,
  };
  const scene: RoomScene = {
    map: o.map,
    textures: o.textures,
    eye: localPlayer.eye(),
    lighting: null,
    reflections: 'none',
    people: world.sprites,
    objects: world.voxels,
    labels: world.labels,
    ownGlow: null,
    lighters: world.lighters,
    ownLighter: null,
    headlights: world.headlights,
    ownHeadlight: null,
    lighterSeconds: 0,
    self: null,
    ownScooter: null,
    ownLabel: null,
    portalPulse: 1,
    portalTime: 0,
    firstPerson: null,
    portals: null,
  };

  // Slow light (D39): the bend, the own motion that aims it, and what the light delay is measured from.
  const bend = createBend();
  const ownMotion = createOwnMotion();
  const seenLight: SeenLight = { map: o.map, portals: null, eye: { x: 0, y: 0 }, lightSpeed: 1 };
  /** Where the local player stood, frame by frame: through a portal their own disc is seen as late as its light. */
  const ownTrail = createTrail();
  const ownSeen: PlayerState = { x: 0, y: 0, angle: 0 };
  const ownImage: Apparent = { x: 0, y: 0, sees: false, through: 0, cos: 1, sin: 0 };
  /** This frame's slow light, or null while light is instant. */
  let light: SeenLight | null = null;

  // The lights-out wave (D41): what the instant frame showed of the room's light, change by change, replayed per place.
  const timeline = createLightTimeline();
  let wave = createLightWave();
  /** The room and the light the timeline was last fed: a new room, look or slow light on starts it again. */
  let fedRoom: Room | null = null;
  let fedLighting: Lighting | null = null;
  let fedSight: Portals | null = null;
  /** Long enough for any change to have travelled lamp → place → eye across the whole map. */
  const longestPath = 2 * Math.hypot(o.map.width, o.map.height);

  /** Whether going from what was fed to (lighting, sight) is this person's setting, not the room's light changing. */
  const lookChanged = (lighting: Lighting | null, sight: Portals | null) =>
    (lighting === null) !== (fedLighting === null) || (sight !== null && fedSight !== null && sight !== fedSight);

  /** The frame's lighting with slow light: the wave while a change is still on its way somewhere, else `instant`. */
  const seenLighting = (room: Room | null, instant: Lighting | null, sight: Portals | null): Lighting | null => {
    if (light === null || room === null || instant === null) {
      fedRoom = null;
      return instant;
    }
    const now = performance.now();
    if (fedRoom !== room || lookChanged(instant, sight)) {
      if (fedRoom !== room) {
        wave = createLightWave();
      }
      for (const table of room.litTables()) {
        wave.prepare(table);
      }
      timeline.reset(now, instant, sight);
    } else {
      timeline.record(now, instant, sight);
    }
    fedRoom = room;
    fedLighting = instant;
    fedSight = sight;
    const stillOnItsWay = timeline.changedSince(now - (longestPath / light.lightSpeed) * 1000);
    return stillOnItsWay ? wave.update(timeline, light.eye, now, light.lightSpeed) : instant;
  };

  /** Refills the slow light for this frame from the console's setting; null, and the motion forgotten, while off. */
  const updateLight = (room: Room | null, dt: number): SeenLight | null => {
    const lightSpeed = o.slowLight();
    if (lightSpeed === null) {
      ownMotion.reset();
      return null;
    }
    const eye = localPlayer.eye();
    seenLight.portals = room?.sightPortals() ?? null;
    seenLight.eye.x = eye.x;
    seenLight.eye.y = eye.y;
    seenLight.lightSpeed = lightSpeed;
    const { pose } = localPlayer;
    bend.aim(screen.fb, ownMotion.update(pose.x, pose.y, eye.angle, dt, lightSpeed));
    ownTrail.push(performance.now(), pose.x, pose.y, pose.angle);
    return seenLight;
  };

  /**
   * Moves the own disc, its scooter and label's spot to where the local player stood when the light their image shows
   * left: one step, from the image's distance now.
   */
  const delayOwnImage = (now: number): PlayerState => {
    const eye = localPlayer.eye();
    if (light === null || light.portals === null) {
      ownSeen.x = eye.x;
      ownSeen.y = eye.y;
      return ownSeen;
    }
    imagePosition(o.map, light.portals, eye, eye, ownImage);
    const distance = Math.hypot(ownImage.x - eye.x, ownImage.y - eye.y);
    ownTrail.buffer.sample(now - (distance / light.lightSpeed) * 1000, ownSeen);
    if (scene.self) {
      scene.self.x = ownSeen.x;
      scene.self.y = ownSeen.y;
    }
    if (scene.ownScooter) {
      scene.ownScooter.x = ownSeen.x;
      scene.ownScooter.y = ownSeen.y;
      scene.ownScooter.angle = ownSeen.angle;
    }
    return ownSeen;
  };

  const ownLabel: NameLabel = { shownX: 0, shownY: 0, name: '', mic: false };
  /** The own label, named as the others see it, where a portal shows the own `spot`; else null. */
  const labelOwnImage = (room: Room | null, spot: Point): NameLabel | null => {
    if (
      scene.self === null ||
      room === null ||
      !placeOwnLabel(o.map, scene.portals ?? null, localPlayer.eye(), ownLabel, spot)
    ) {
      return null;
    }
    ownLabel.name = room.session.selfName();
    ownLabel.mic = room.session.selfMic();
    return ownLabel;
  };

  const cues: SequenceCues = { countdown: false, lightsOff: false, portalsOn: false, lightsOn: false };

  /**
   * Moves the room's portal sequence on, shows its countdown and plays its sounds, hidden tab included: the sounds are
   * for everyone, and the hidden tick comes well within a cue's lateness, so none plays stale.
   */
  const followSequence = (room: Room, now: number) => {
    room.sequence.update(room.session.sequence, now, room.session.portals);
    showCountdown(o.ui, room.sequence.countdown);
    room.sequence.takeCues(cues);
    if (cues.countdown) {
      room.switchSounds.countdown();
    }
    if (cues.lightsOff) {
      room.switchSounds.lightsOff();
    }
    if (cues.portalsOn) {
      room.switchSounds.portalsOn();
    }
    if (cues.lightsOn) {
      room.switchSounds.lightsOn();
    }
  };

  /** The local player as the ball feels them, with their velocity from the last frame's move. */
  const self: BallBody = { kind: 'person', x: 0, y: 0, vx: 0, vy: 0, radius: PLAYER_RADIUS };
  let selfSeen = false;
  let roll = createBallRoll();
  /** The ball the roll belongs to, and where it was last drawn. */
  let rolling: { id: string; x: number; y: number } | null = null;

  const using: UseState = { riding: false, dribbling: false, ballTiles: null, scooterTiles: null };
  /** What E would do now (ball dribble spec §2.1). */
  const useChoice = (room: Room): UseChoice | null => {
    const { pose } = localPlayer;
    const ball = room.ball.ball;
    const ballTiles = ball && Math.hypot(ball.x - pose.x, ball.y - pose.y);
    const ballLoose = !room.ball.holding && room.ball.heldBy === null;
    using.riding = room.session.riding !== null;
    using.dribbling = room.ball.holding;
    using.ballTiles = ballLoose && ballTiles !== null && ballTiles <= BALL_KICK_REACH ? ballTiles : null;
    using.scooterTiles = room.ride.nearestTiles(pose, apparent);
    return chooseUse(using);
  };

  /** Steps the predicted ball and plays what it hit. */
  const stepBall = (room: Room, now: number, dt: number) => {
    const { pose } = localPlayer;
    const walked = selfSeen && dt > 0 && Math.hypot(pose.x - self.x, pose.y - self.y) <= JUMP_TILES;
    self.vx = walked ? (pose.x - self.x) / dt : 0;
    self.vy = walked ? (pose.y - self.y) / dt : 0;
    self.x = pose.x;
    self.y = pose.y;
    selfSeen = true;
    const connected = isConnected(room);
    const event = room.ball.step(dt, now, connected ? self : null, localPlayer.eye().angle);
    localPlayer.dribbling = room.ball.holding;
    const ball = room.ball.ball;
    if (ball && room.ball.dribbleTouch) {
      room.objectSounds.dribble(ball.id);
    }
    o.ballInReach(connected && ball !== null && Math.hypot(ball.x - pose.x, ball.y - pose.y) <= BALL_KICK_REACH);
    if (ball && event) {
      room.objectSounds.localEvent(ball.id, event);
    }
  };

  /** Rolls the ball's pattern by how far it went where it is seen: with slow light, as late as its light. */
  const rollBallPattern = (room: Room) => {
    const id = room.ball.ball?.id;
    const seen = world.ballSeen;
    if (id === undefined || seen === null) {
      return;
    }
    if (rolling?.id !== id) {
      roll = createBallRoll();
      rolling = { id, x: seen.x, y: seen.y };
      recolourBall(BALL_MODEL, roll);
    }
    const movedTiles = Math.hypot(seen.x - rolling.x, seen.y - rolling.y);
    // A move longer than a jump went through a portal: the ball came out elsewhere, it didn't roll there.
    if (movedTiles > 0 && movedTiles <= JUMP_TILES) {
      rollBy(roll, seen.x - rolling.x, seen.y - rolling.y);
      recolourBall(BALL_MODEL, roll);
    }
    rolling.x = seen.x;
    rolling.y = seen.y;
  };

  const stepLocalPlayer = (dt: number) => {
    // Consumed outside the room too, so a turn made before it doesn't land on the first frame in it.
    const turn = o.input.consumeMouseTurn();
    const room = o.room();
    const ridden = room?.session.riding ?? null;
    const steppingOn = ridesNow(room?.session ?? null) && !localPlayer.riding;
    localPlayer.riding = ridesNow(room?.session ?? null);
    // A rider back after a reload has no ask behind them, so keeps the pose the server gave.
    const parkedHeading = steppingOn && ridden !== null ? (room?.ride.headingOf(ridden) ?? null) : null;
    if (parkedHeading !== null) {
      localPlayer.faceScooter(parkedHeading);
    }
    if (isConnected(room)) {
      localPlayer.walk(o.map, o.input.state(), turn, dt, room?.portals());
    }
  };

  /** Puts a thing at `things[n]`, reusing the one there. */
  const placeThing = (n: number, id: string, pos: { x: number; y: number }) => {
    const thing = things.at(n) ?? { id, x: 0, y: 0 };
    thing.id = id;
    thing.x = pos.x;
    thing.y = pos.y;
    things[n] = thing;
  };

  /**
   * Where everyone and everything appears to the local player's eye, through the room's portals when they are on, the
   * doorways' hums included.
   */
  const placeApparently = (room: Room) => {
    let n = 0;
    for (const [id, pos] of world.positions) {
      placeThing(n++, id, pos);
    }
    room.hums.sourcesOf(room.sightPortals(), humSources);
    for (const [id, pos] of humSources) {
      placeThing(n++, id, pos);
    }
    things.length = n;
    apparent = apparentWorld.update(o.map, room.sightPortals(), localPlayer.eye(), things);
  };

  const placeEveryoneElse = (room: Room, now: number, dt: number) => {
    const { session } = room;
    world.sample(session, localPlayer.pose, now, room.ball, room.portals(), light);
    rollBallPattern(room);
    placeApparently(room);
    world.collect(session, peerMedia, now, dt, apparent);
    room.objectSounds.sync(session.objects, world.objectPoses, dt);
    room.scooterSounds.sync(session.peers, world.positions, dt, now);
    const { speed, bump } = localPlayer.ride;
    room.scooterSounds.own(speed, ownLoad(o.input.state().forward, speed), bump, localPlayer.riding, dt);
    // Bots count too: the client can't tell them from people.
    const people = session.status() === 'open' ? session.peers.size + 1 : null;
    o.statusLine.show(statusText(session.status(), session.error()), people);
    room.audio.update(now, localPlayer.eye(), apparent);
  };

  const describeScene = (now: number) => {
    // The console's lighting mode; flat is drawn unlit, as with `?lights=off`.
    // The pooled eye pose the scene holds, refilled: the head may have turned since the last frame.
    localPlayer.eye();
    const reflections = litReflections(o.renderMode());
    scene.reflections = reflections ?? 'none';
    const room = o.room();
    scene.portals = room?.sightPortals() ?? null;
    const instant = reflections === null ? null : (room?.lighting(room.sequence.dark) ?? o.roomLighting());
    scene.lighting = seenLighting(room, instant, scene.portals);
    const portalSeconds = performance.now() / 1000;
    scene.portalPulse = portalPulse(portalSeconds);
    scene.portalTime = portalSeconds;
    scene.lighterSeconds = portalSeconds;
    const ringColour = room?.session.selfColor() ?? null;
    scene.ownGlow = localPlayer.glow(now, ringColour);
    // Held only in the room: the lobby shows no hands.
    scene.ownLighter = isConnected(room) ? localPlayer.lighter() : null;
    scene.ownHeadlight = isConnected(room) ? localPlayer.headlight() : null;
    // Only windows draw the own disc, and reading its face back stalls on the GPU: read it only while one shows it.
    scene.self = scene.portals && isConnected(room) ? localPlayer.avatar(now, ringColour, ownAvatarShown()) : null;
    scene.ownScooter = scene.self ? localPlayer.scooter() : null;
    scene.ownLabel = labelOwnImage(room, delayOwnImage(now));
    scene.firstPerson = isConnected(room) ? localPlayer.firstPerson(now) : null;
    return scene;
  };

  const chooseWhatToReceive = (room: Room, now: number, hidden: boolean) => {
    subscription.choose(now, {
      call: room.call,
      people: room.session.peers,
      positions: apparent,
      player: localPlayer.eye(),
      fov: screen.fb.fov,
      map: o.map,
      maxDistance: room.audio.settings().max,
      hidden,
    });
  };

  return {
    frame(dt) {
      stepLocalPlayer(dt);
      const now = performance.now();
      const room = o.room();
      light = updateLight(room, dt);
      if (room) {
        room.call.setFaceHistory(light !== null);
        room.call.update(now);
        followSequence(room, now);
        stepBall(room, now, dt);
        placeEveryoneElse(room, now, dt);
        o.useState(isConnected(room) ? useChoice(room) : null);
      } else {
        showCountdown(o.ui, null);
      }
      const drawStart = performance.now();
      const shown = describeScene(drawStart);
      // The hum swells with the very pulse this frame's glow is drawn with.
      room?.hums.sync(room.sightPortals(), shown.portalPulse, localPlayer.eye(), apparent);
      const bent = light === null ? null : bend;
      renderView(screen.fb, shown, subscription.seen, bent);
      screen.present();
      renderHud(o.hud, screen.fb, shown, o.showMap(), bent);
      const drawnAt = performance.now();
      // dt comes from rAF's timestamps, which fall on the screen's refreshes.
      o.frameRate.frame(drawnAt, dt * 1000, drawnAt - drawStart);
      if (room) {
        chooseWhatToReceive(room, drawnAt, document.hidden);
      }
    },
    whileHidden() {
      const room = o.room();
      if (!room) {
        return;
      }
      const now = performance.now();
      followSequence(room, now);
      stepBall(room, now, HIDDEN_TICK_MS / 1000);
      light = updateLight(room, HIDDEN_TICK_MS / 1000);
      world.sample(room.session, localPlayer.pose, now, room.ball, room.portals(), light);
      rollBallPattern(room);
      placeApparently(room);
      room.objectSounds.sync(room.session.objects, world.objectPoses, HIDDEN_TICK_MS / 1000);
      room.scooterSounds.sync(room.session.peers, world.positions, HIDDEN_TICK_MS / 1000, now);
      // Hidden, the local player stands still, so their own motor is quiet.
      room.scooterSounds.own(0, 'coasting', 0, localPlayer.riding, HIDDEN_TICK_MS / 1000);
      room.hums.sync(room.sightPortals(), portalPulse(now / 1000), localPlayer.eye(), apparent);
      room.audio.update(now, localPlayer.eye(), apparent);
      chooseWhatToReceive(room, now, true);
    },
  };
}
