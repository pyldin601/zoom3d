// The room from Join on: the game session, the call carrying everyone's media, the spatial audio, the world objects'
// sounds, the ball as this client predicts it, the player's boombox and the analytics tracker, made together on Join
// and kept together.
import { type GameMap, type HeldItem, type PlayerState, type Portals, wirePortals } from '@zoom3d/shared';
import { createDoorbell, withDoorbell } from '../audio/doorbell';
import { type AudioEngine, createAudioEngine } from '../audio/engine';
import { createObjectSounds, type ObjectSounds } from '../audio/object-sounds';
import { type Boombox, createBoombox } from '../media/boombox';
import { type Call, createCall } from '../media/call';
import { createFace } from '../media/faces';
import { createLiveKitTransport } from '../media/livekit';
import type { LocalMediaController } from '../media/local-media';
import { createRemoteMedia } from '../media/remote-media';
import { createSession, type Session } from '../net/session';
import { track } from '../telemetry/analytics';
import { createRoomTracker, type RoomTracker, withRoomTracker } from '../telemetry/room-tracker';
import { botsParam } from '../ui/route';
import { type BallPrediction, createBallPrediction } from './ball-prediction';

export interface Room {
  readonly session: Session;
  readonly call: Call;
  readonly audio: AudioEngine;
  readonly objectSounds: ObjectSounds;
  readonly boombox: Boombox;
  readonly tracker: RoomTracker;
  readonly ball: BallPrediction;
  /** The map's portal wiring while the room's portals are on, else null: today's doors. */
  portals(): Portals | null;
  /** Kicks the ball the way the local player faces, if it is in reach: at once here, and on to the server. */
  kick(): void;
}

export interface JoinOptions {
  roomId: string;
  name: string;
  avatar: string | null;
  /** The lobby's camera, mic and AudioContext, handed over on Join (lobby spec §4.5). */
  local: LocalMediaController;
  audioCtx: AudioContext;
  map: GameMap;
  player: PlayerState;
  /** Where remote media plays (muted) and where the boombox's own element goes. */
  mediaContainer: HTMLElement;
  localMediaContainer: HTMLElement;
  drink: HeldItem | null;
  boomboxVolume: number;
  onBoomboxChange(on: boolean): void;
  /** Someone flipped the room's portals (not called for the welcome's flag). */
  onPortalsChanged(on: boolean): void;
}

export function joinRoom(opts: JoinOptions): Room {
  const audio = createAudioEngine({ ctx: opts.audioCtx, map: opts.map });
  let session: Session | null = null;
  const objectSounds = createObjectSounds(opts.audioCtx, audio, () => session?.selfId() ?? null);
  const call = createRoomCall(opts, audio);
  const tracker = createRoomTracker(track, () => performance.now());
  const ball = createBallPrediction(opts.map, () => portals());
  const joined = connectSession(opts, call, tracker, objectSounds, ball, () => portals());
  session = joined;
  call.attach(joined);
  const boombox = createOwnBoombox(opts, call, joined);
  const kick = () => {
    const { player } = opts;
    const k = ball.kick(player, player.angle, performance.now());
    const kicked = ball.ball;
    if (k !== null && kicked) {
      joined.sendKick(player.angle, k);
      objectSounds.localEvent(kicked.id, 'kick');
    }
  };
  let wiring: Portals | null = null;
  function portals() {
    if (!joined.portals) {
      return null;
    }
    wiring ??= wirePortals(opts.map, opts.roomId);
    return wiring;
  }
  return { session: joined, call, audio, objectSounds, boombox, tracker, ball, portals, kick };
}

/** In the room and connected: not joining, reconnecting or failed. */
export function isConnected(room: Room | null): boolean {
  return room?.session.status() === 'open';
}

function createRoomCall(opts: JoinOptions, audio: AudioEngine): Call {
  return createCall({
    local: opts.local,
    remote: createRemoteMedia(opts.mediaContainer),
    audio,
    document,
    createFace,
    createTransport: createLiveKitTransport,
  });
}

function connectSession(
  opts: JoinOptions,
  call: Call,
  tracker: RoomTracker,
  sounds: ObjectSounds,
  ball: BallPrediction,
  portals: () => Portals | null
): Session {
  const session: Session = createSession({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    roomId: opts.roomId,
    name: opts.name,
    avatar: opts.avatar,
    bots: botsParam(location.search),
    player: opts.player,
    map: opts.map,
    portals,
    now: () => performance.now(),
    listener: {
      ...withRoomTracker(withDoorbell(call.listener, createDoorbell(opts.audioCtx)), tracker, () => session),
      portalsChanged: (on) => opts.onPortalsChanged(on),
      objectEvent: (id, e, by) => sounds.event(id, e, by),
      objectState: (m) => ball.server(m, session.selfId(), performance.now()),
      objectsReset: (objects) => ball.reset(objects.find((o) => o.kind === 'ball') ?? null),
    },
  });
  session.setHeld(opts.drink);
  session.setBoombox(false);
  return session;
}

function createOwnBoombox(opts: JoinOptions, call: Call, session: Session): Boombox {
  const boombox = createBoombox({
    ctx: opts.audioCtx,
    container: opts.localMediaContainer,
    onTrack: (music) => call.setBoomboxTrack(music),
    onChange(on) {
      if (on) {
        track({ name: 'boombox_started' });
      }
      opts.onBoomboxChange(on);
      session.setBoombox(on);
    },
  });
  boombox.setVolume(opts.boomboxVolume);
  return boombox;
}
