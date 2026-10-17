// The room's frame: the local player steps, everyone else and the world objects are placed and heard, the view and
// the HUD are drawn, then the subscription picks whose media to receive. While the tab is hidden rAF stops, so a timer
// keeps the sound and the subscription going instead.
import type { GameMap } from '@zoom3d/shared';
import { HIDDEN_TICK_MS } from '../audio/ticker';
import type { Input } from '../input/keyboard';
import { createSubscription } from '../media/subscription';
import { type RoomScene, renderHud, renderView } from '../renderer/frame';
import type { Lighting } from '../renderer/lighting';
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

  const stepLocalPlayer = (dt: number) => {
    // Consumed outside the room too, so a turn made before it doesn't land on the first frame in it.
    const turn = o.input.consumeMouseTurn();
    if (isConnected(o.room())) {
      localPlayer.walk(o.map, o.input.state(), turn, dt);
    }
  };

  const placeEveryoneElse = (room: Room, now: number, dt: number) => {
    const { session } = room;
    world.sample(session, localPlayer.pose, now);
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
      world.sample(room.session, localPlayer.pose, now);
      room.objectSounds.sync(room.session.objects, world.objectPoses, HIDDEN_TICK_MS / 1000);
      room.audio.update(now, localPlayer.pose, world.positions);
      chooseWhatToReceive(room, now, true);
    },
  };
}
