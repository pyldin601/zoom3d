// The other people and the world objects as the room frame shows them: their interpolated positions, for the audio
// and the interest rule, and the discs, name labels and voxel models the renderer draws. Each peer keeps one record
// from frame to frame, so a full room allocates nothing per frame (AGENTS.md: never block the render loop).
import {
  type Apparent,
  INTERP_DELAY_MS,
  isDrink,
  type ObjectKind,
  type PlayerState,
  type Point,
  type Portals,
} from '@zoom3d/shared';
import { nearTier } from '../net/peer-delay';
import { objectKey, type RemotePeer, type Session } from '../net/session';
import { type Bob, createBob } from '../renderer/bob';
import type { LighterSource } from '../renderer/lighter';
import { BALL_MODEL } from '../renderer/models/ball';
import { SCOOTER_DECK_TILES, SCOOTER_MODEL } from '../renderer/models/scooter';
import { VACUUM_MODEL } from '../renderer/models/vacuum';
import { gesturePose } from '../renderer/sip';
import { ringRgb, type Sprite } from '../renderer/sprites';
import type { VoxelInstance, VoxelModel } from '../renderer/voxels';
import type { BallPrediction } from './ball-prediction';
import { ballShake } from './ball-shake';

/** A peer's name label and automap dot. */
export interface PeerLabel {
  /** Where they are: the automap's dot. */
  x: number;
  y: number;
  /** Where they appear to the local player (through a portal, at its doorway): the name's place in the view. */
  shownX: number;
  shownY: number;
  /** The ring colour as the server sent it, #rrggbb. */
  color: string;
  name: string;
  mic: boolean;
}

/** What the world shows of each peer's media. */
export interface PeerMedia {
  /** The face texels to draw, or null for a flat disc. */
  faceOf(peerId: string): Uint32Array | null;
  /** 0..1: how loudly they speak now. */
  speaking(peerId: string): number;
}

export interface RemoteWorld {
  /** Where each peer (by id) and each world object (by objectKey) is now; the same objects from frame to frame. */
  readonly positions: ReadonlyMap<string, Point>;
  /** Each world object's pose now, by objectKey: the same objects as in `positions`. */
  readonly objectPoses: ReadonlyMap<string, PlayerState>;
  /** This frame's discs, labels and voxel models, from `collect`; reused objects, so read them before the next. */
  readonly sprites: readonly Sprite[];
  readonly labels: readonly PeerLabel[];
  readonly voxels: readonly VoxelInstance[];
  /** This frame's lit lighters, from `collect`: everyone holding one and where they stand. Reused objects. */
  readonly lighters: readonly LighterSource[];
  /**
   * Samples every peer's and object's position at `now`: every frame, and from the hidden-tab ticker. The ball is the
   * one object not drawn from its buffer: it is where the client's prediction has it, in the present (ball spec §3.3).
   * `portals` (the room's wiring while they are on) decides, as on the server, which peers are near.
   */
  sample(session: Session, player: Point, now: number, ball?: ShownBall | null, portals?: Portals | null): void;
  /**
   * Builds this frame's sprites, labels and voxels from the last sample; `dt` (seconds) walks the bobs. `apparent`
   * places the labels; a person it doesn't list is labelled where they are.
   */
  collect(session: Session, media: PeerMedia, now: number, dt: number, apparent?: ReadonlyMap<string, Apparent>): void;
}

/** One peer's pieces, kept while they have a position. */
interface PeerRecord {
  bob: Bob;
  sprite: Sprite;
  label: PeerLabel;
  lighter: { key: string; x: number; y: number };
}

/** The ball as this client shows it: where it is predicted, its mood and how high it is drawn (BallPrediction). */
export type ShownBall = Pick<BallPrediction, 'ball' | 'mood' | 'lift'>;

const MODELS: Record<ObjectKind, VoxelModel> = { vacuum: VACUUM_MODEL, ball: BALL_MODEL, scooter: SCOOTER_MODEL };

/** An object's pose to draw, with how high above the floor (only the ball's hop lifts one). */
interface ObjectPose extends PlayerState {
  lift: number;
}

export function createRemoteWorld(): RemoteWorld {
  const positions = new Map<string, Point>();
  /** Each peer's drawn heading, by id, beside its position: a ridden scooter points the way its rider faces. */
  const headings = new Map<string, number>();
  const objectPoses = new Map<string, ObjectPose>();
  /** Each object's objectKey, made once rather than every frame. */
  const objectKeys = new Map<string, string>();
  const records = new Map<string, PeerRecord>();
  const sprites: Sprite[] = [];
  const labels: PeerLabel[] = [];
  const lighters: LighterSource[] = [];
  const voxels: VoxelInstance[] = [];
  const at = { x: 0, y: 0, angle: 0 };
  let atLift = 0;

  /** Drops the positions of objects and peers the session no longer has. */
  const forgetGone = (s: Session) => {
    for (const [id, key] of objectKeys) {
      if (!s.objects.has(id)) {
        objectKeys.delete(id);
        objectPoses.delete(key);
      }
    }
    for (const id of positions.keys()) {
      if (!s.peers.has(id) && !objectPoses.has(id)) {
        positions.delete(id);
        headings.delete(id);
      }
    }
  };

  const shake = { x: 0, y: 0 };
  const sampleObjects = (s: Session, now: number, shown: ShownBall | null) => {
    const ball = shown?.ball ?? null;
    // Objects come every tick; each peer is drawn as late as its updates need (6d spec §2.3).
    const drawnAt = now - INTERP_DELAY_MS;
    for (const obj of s.objects.values()) {
      const id = obj.info.id;
      if (obj.info.kind === 'ball') {
        if (ball?.id !== id) {
          continue;
        }
        // Its pattern rolls in world axes (models/ball.ts), so the model itself never turns.
        ballShake(shown?.mood ?? 'asleep', now, shake);
        at.x = ball.x + shake.x;
        at.y = ball.y + shake.y;
        at.angle = 0;
        atLift = shown?.lift ?? 0;
      } else if (obj.buffer.sample(drawnAt, at)) {
        atLift = 0;
      } else {
        continue;
      }
      let key = objectKeys.get(id);
      if (key === undefined) {
        key = objectKey(id);
        objectKeys.set(id, key);
      }
      const pose = objectPoses.get(key);
      if (pose) {
        pose.x = at.x;
        pose.y = at.y;
        pose.angle = at.angle;
        pose.lift = atLift;
      } else {
        const fresh = { x: at.x, y: at.y, angle: at.angle, lift: atLift };
        objectPoses.set(key, fresh);
        positions.set(key, fresh);
      }
    }
  };

  const samplePeers = (s: Session, player: Point, now: number, portals: Portals | null) => {
    for (const peer of s.peers.values()) {
      const delay = peer.delay.update(now, nearTier(portals, player, peer.info.x, peer.info.y));
      if (!peer.buffer.sample(now - delay, at)) {
        continue;
      }
      const pos = positions.get(peer.info.id);
      if (pos) {
        pos.x = at.x;
        pos.y = at.y;
      } else {
        positions.set(peer.info.id, { x: at.x, y: at.y });
      }
      headings.set(peer.info.id, at.angle);
    }
  };

  const recordOf = (id: string): PeerRecord => {
    let record = records.get(id);
    if (!record) {
      record = {
        bob: createBob(),
        sprite: blankSprite(id),
        label: { x: 0, y: 0, shownX: 0, shownY: 0, color: '', name: '', mic: false },
        lighter: { key: id, x: 0, y: 0 },
      };
      records.set(id, record);
    }
    return record;
  };

  const collectPeers = (
    s: Session,
    media: PeerMedia,
    now: number,
    dt: number,
    apparent: ReadonlyMap<string, Apparent> | undefined
  ) => {
    for (const id of records.keys()) {
      if (!positions.has(id)) {
        records.delete(id);
      }
    }
    let n = 0;
    let lit = 0;
    for (const peer of s.peers.values()) {
      const id = peer.info.id;
      const pos = positions.get(id);
      if (!pos) {
        continue;
      }
      const { bob, sprite, label, lighter } = recordOf(id);
      bob.update(pos.x, pos.y, dt);
      // Both hands are on the handlebar while riding: the lighter is put away.
      if (peer.info.held === 'lighter' && peer.info.riding === null) {
        lighter.x = pos.x;
        lighter.y = pos.y;
        lighters[lit++] = lighter;
      }
      fillSprite(sprite, peer, pos, bob, media, now);
      fillLabel(label, peer, pos, apparent?.get(id) ?? pos);
      sprites[n] = sprite;
      labels[n] = label;
      n++;
    }
    // Written by index and trimmed: `length = 0` would make V8 drop the arrays' storage every frame.
    sprites.length = n;
    labels.length = n;
    lighters.length = lit;
  };

  /** Puts a model at `voxels[n]`, reusing the instance there. */
  const placeVoxel = (n: number, model: VoxelModel, x: number, y: number, angle: number, lift: number) => {
    const v = voxels.at(n) ?? { model, x: 0, y: 0, angle: 0, lift: 0 };
    v.model = model;
    v.x = x;
    v.y = y;
    v.angle = angle;
    v.lift = lift;
    voxels[n] = v;
  };

  const collectVoxels = (s: Session) => {
    let n = 0;
    for (const obj of s.objects.values()) {
      const key = objectKeys.get(obj.info.id);
      const pose = key === undefined ? undefined : objectPoses.get(key);
      if (pose) {
        placeVoxel(n++, MODELS[obj.info.kind], pose.x, pose.y, pose.angle, pose.lift);
      }
    }
    // A ridden scooter is drawn from its rider's own drawn pose, so the two can't drift apart.
    for (const peer of s.peers.values()) {
      const pos = peer.info.riding === null ? undefined : positions.get(peer.info.id);
      if (pos) {
        placeVoxel(n++, SCOOTER_MODEL, pos.x, pos.y, headings.get(peer.info.id) ?? 0, 0);
      }
    }
    voxels.length = n;
  };

  return {
    positions,
    objectPoses,
    sprites,
    labels,
    voxels,
    lighters,
    sample(s, player, now, ball = null, portals = null) {
      forgetGone(s);
      sampleObjects(s, now, ball);
      samplePeers(s, player, now, portals);
    },
    collect(s, media, now, dt, apparent) {
      collectPeers(s, media, now, dt, apparent);
      collectVoxels(s);
    },
  };
}

/** A sprite with no one's look yet, filled frame by frame. */
export function blankSprite(key: string): Sprite {
  return {
    key,
    x: 0,
    y: 0,
    color: 0,
    face: null,
    speaking: 0,
    bob: 0,
    itemBob: 0,
    ride: 0,
    sip: 0,
    cheers: 0,
    wobble: 0,
    held: null,
    boombox: false,
  };
}

/** A peer's disc this frame: where they are, their face and ring, their step and what their drink is doing. */
function fillSprite(sprite: Sprite, peer: RemotePeer, pos: Point, bob: Bob, media: PeerMedia, now: number): void {
  const { id, color, held, boombox } = peer.info;
  sprite.x = pos.x;
  sprite.y = pos.y;
  sprite.color = ringRgb(color);
  sprite.face = media.faceOf(id);
  sprite.speaking = media.speaking(id);
  // A rider glides on the deck: no step.
  const riding = peer.info.riding !== null;
  sprite.bob = riding ? 0 : bob.lift;
  sprite.itemBob = riding ? 0 : bob.itemLift;
  sprite.ride = riding ? SCOOTER_DECK_TILES : 0;
  const gesture = peer.gesture;
  // The sprite's sip, cheers and wobble are a HeldPose. The lighter has no gestures: one under way when it was taken
  // stops.
  const shown = gesture && isDrink(held) ? gesture : null;
  gesturePose(shown ? shown.kind : null, shown ? now - shown.at : 0, sprite);
  sprite.held = riding ? null : held;
  sprite.boombox = riding ? false : boombox;
}

function fillLabel(label: PeerLabel, peer: RemotePeer, pos: Point, shown: Point): void {
  label.x = pos.x;
  label.y = pos.y;
  label.shownX = shown.x;
  label.shownY = shown.y;
  label.color = peer.info.color;
  label.name = peer.info.name;
  label.mic = peer.info.mic;
}
