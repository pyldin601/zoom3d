// The room's frame: the local player steps, then the ball the client predicts, everyone else and the world objects are
// placed and heard, the view and the HUD are drawn, then the subscription picks whose media to receive. While the tab is hidden rAF stops, so a timer
// keeps the sound and the subscription going instead.
import { type BallBody, type GameMap, PLAYER_RADIUS } from '@zoom3d/shared';
import { HIDDEN_TICK_MS } from '../audio/ticker';
import type { Input } from '../input/keyboard';
import { createSubscription } from '../media/subscription';
import { type RoomScene, renderHud, renderView } from '../renderer/frame';
import type { Lighting } from '../renderer/lighting';
import { BALL_MODEL, createBallRoll, recolourBall, rollBy } from '../renderer/models/ball';
import { litReflections, type RenderMode } from '../ui/render-settings';
import { type StatusLine, statusText } from '../ui/room-status';
import type { FrameRateMeter } from './frame-rate';
import type { LocalPlayer } from './local-player';
import { createRemoteWorld, type PeerMedia } from './remote-world';
import { isConnected, type Room } from './room';
import type { Screen } from './screen';

export interface RoomLoopOptions {
  map: GameMap;
  textures: Uint32Array[];
  localPlayer: LocalPlayer;
  input: Input;
  screen: Screen;
  hud: CanvasRenderingContext2D;
  frameRate: FrameRateMeter;
  statusLine: StatusLine;
  room(): Room | null;
  renderMode(): RenderMode;
  roomLighting(): Lighting | null;
  showMap(): boolean;
}

export interface RoomLoop {
  frame(dt: number): void;
  whileHidden(): void;
}

export function createRoomLoop(o: RoomLoopOptions): RoomLoop {
  const { localPlayer, screen } = o;
  const world = createRemoteWorld();
  const subscription = createSubscription();
  const peerMedia: PeerMedia = {
    faceOf: (id) => o.room()?.call.faceOf(id) ?? null,
    speaking: (id) => o.room()?.audio.speaking(id) ?? 0,
  };
  const scene: RoomScene = {
    map: o.map,
    textures: o.textures,
    eye: localPlayer.pose,
    lighting: null,
    reflections: 'none',
    people: world.sprites,
    objects: world.voxels,
    labels: world.labels,
    ownGlow: null,
    firstPerson: null,
  };

  /** The local player as the ball feels them, with their velocity from the last frame's move. */
  const self: BallBody = { kind: 'person', x: 0, y: 0, vx: 0, vy: 0, radius: PLAYER_RADIUS };
  let selfSeen = false;
  let roll = createBallRoll();
  /** The ball the roll belongs to, and where it was last drawn. */
  let rolling: { id: string; x: number; y: number } | null = null;

  /** Steps the predicted ball, rolls its pattern by how far it went, and plays what it hit. */
  const stepBall = (room: Room, now: number, dt: number) => {
    const { pose } = localPlayer;
    self.vx = selfSeen && dt > 0 ? (pose.x - self.x) / dt : 0;
    self.vy = selfSeen && dt > 0 ? (pose.y - self.y) / dt : 0;
    self.x = pose.x;
    self.y = pose.y;
    selfSeen = true;
    const event = room.ball.step(dt, now, isConnected(room) ? self : null);
    const ball = room.ball.ball;
    if (!ball) {
      return;
    }
    if (rolling?.id !== ball.id) {
      roll = createBallRoll();
      rolling = { id: ball.id, x: ball.x, y: ball.y };
      recolourBall(BALL_MODEL, roll);
    }
    if (ball.x !== rolling.x || ball.y !== rolling.y) {
      rollBy(roll, ball.x - rolling.x, ball.y - rolling.y);
      rolling.x = ball.x;
      rolling.y = ball.y;
      recolourBall(BALL_MODEL, roll);
    }
    if (event) {
      room.objectSounds.localEvent(ball.id, event);
    }
  };

  const stepLocalPlayer = (dt: number) => {
    // Consumed outside the room too, so a turn made before it doesn't land on the first frame in it.
    const turn = o.input.consumeMouseTurn();
    if (isConnected(o.room())) {
      localPlayer.walk(o.map, o.input.state(), turn, dt);
    }
  };

  const placeEveryoneElse = (room: Room, now: number, dt: number) => {
    const { session } = room;
    world.sample(session, localPlayer.pose, now, room.ball.ball);
    world.collect(session, peerMedia, now, dt);
    room.objectSounds.sync(session.objects, world.objectPoses, dt);
    // Bots count too: the client can't tell them from people.
    const people = session.status() === 'open' ? session.peers.size + 1 : null;
    o.statusLine.show(statusText(session.status(), session.error()), people);
    room.audio.update(now, localPlayer.pose, world.positions);
  };

  const describeScene = (now: number) => {
    // The console's lighting mode; flat is drawn unlit, as with `?lights=off`.
    const reflections = litReflections(o.renderMode());
    scene.lighting = reflections === null ? null : o.roomLighting();
    scene.reflections = reflections ?? 'none';
    const room = o.room();
    scene.ownGlow = localPlayer.glow(now, room?.session.selfColor() ?? null);
    scene.firstPerson = isConnected(room) ? localPlayer.firstPerson(now) : null;
    return scene;
  };

  const chooseWhatToReceive = (room: Room, now: number, hidden: boolean) => {
    subscription.choose(now, {
      call: room.call,
      people: room.session.peers,
      positions: world.positions,
      player: localPlayer.pose,
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
      if (room) {
        room.call.update(now);
        stepBall(room, now, dt);
        placeEveryoneElse(room, now, dt);
      }
      const drawStart = performance.now();
      const shown = describeScene(drawStart);
      renderView(screen.fb, shown, subscription.seen);
      screen.present();
      renderHud(o.hud, screen.fb, shown, o.showMap());
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
      stepBall(room, now, HIDDEN_TICK_MS / 1000);
      world.sample(room.session, localPlayer.pose, now, room.ball.ball);
      room.objectSounds.sync(room.session.objects, world.objectPoses, HIDDEN_TICK_MS / 1000);
      room.audio.update(now, localPlayer.pose, world.positions);
      chooseWhatToReceive(room, now, true);
    },
  };
}
