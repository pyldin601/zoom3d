// The other people and the world objects as the room frame shows them: their interpolated positions, for the audio
// and the interest rule, and the discs, name labels and voxel models the renderer draws. Each peer keeps one record
// from frame to frame, so a full room allocates nothing per frame (AGENTS.md: never block the render loop).
import {
  type Apparent,
  INTERP_DELAY_MS,
  isDrink,
  JUMP_TILES,
  type ObjectKind,
  type PlayerState,
  type Point,
  type Portals,
  type SnapshotBuffer,
} from '@zoom3d/shared';
import { nearTier } from '../net/peer-delay';
import { objectKey, type RemoteObject, type RemotePeer, type Session } from '../net/session';
import { type Bob, createBob } from '../renderer/bob';
import type { HeadlightSource } from '../renderer/headlight';
import type { LighterSource } from '../renderer/lighter';
import { BALL_MODEL } from '../renderer/models/ball';
import { RIDDEN_SCOOTER_MODEL, SCOOTER_DECK_TILES, SCOOTER_MODEL } from '../renderer/models/scooter';
import { VACUUM_MODEL } from '../renderer/models/vacuum';
import { gesturePose } from '../renderer/sip';
import { sourceDoppler, terrellTurn } from '../renderer/slow-light-math';
import { shiftSteps } from '../renderer/spectrum';
import { ringRgb, type Sprite } from '../renderer/sprites';
import type { VoxelInstance, VoxelModel } from '../renderer/voxels';
import type { BallPrediction } from './ball-prediction';
import { ballShake } from './ball-shake';
import { createTrail, type SeenLight, seenAt } from './light-delay';
import { createLookRing, createStateRing, liveLook, type PeerLook, type StateRing } from './seen-state';

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
  /** Where the ball is seen, without its tremble (its pattern rolls by this), or null with no ball. Reused. */
  readonly ballSeen: Point | null;
  /** Each world object's pose now, by objectKey: the same objects as in `positions`. */
  readonly objectPoses: ReadonlyMap<string, PlayerState>;
  /** This frame's discs, labels and voxel models, from `collect`; reused objects, so read them before the next. */
  readonly sprites: readonly Sprite[];
  readonly labels: readonly PeerLabel[];
  readonly voxels: readonly VoxelInstance[];
  /** This frame's lit lighters, from `collect`: everyone holding one and where they stand. Reused objects. */
  readonly lighters: readonly LighterSource[];
  /** This frame's riders' headlights, from `collect`: where each rider is drawn and the scooter's heading. */
  readonly headlights: readonly HeadlightSource[];
  /** How late the light shows a peer (by id) or object (by objectKey), with slow light; undefined while it is off. */
  seenOf(key: string): Seen | undefined;
  /**
   * Samples every peer's and object's position at `now`: every frame, and from the hidden-tab ticker. The ball is the
   * one object not drawn from its buffer: it is where the client's prediction has it, in the present (ball spec §3.3).
   * `portals` (the room's wiring while they are on) decides, as on the server, which peers are near. With `light`
   * (slow light, D39), each is drawn where it was when the light reaching the eye now left it.
   */
  sample(
    session: Session,
    player: Point,
    now: number,
    ball?: ShownBall | null,
    portals?: Portals | null,
    light?: SeenLight | null
  ): void;
  /**
   * Builds this frame's sprites, labels and voxels from the last sample; `dt` (seconds) walks the bobs. `apparent`
   * places the labels; a person it doesn't list is labelled where they are.
   */
  collect(session: Session, media: PeerMedia, now: number, dt: number, apparent?: ReadonlyMap<string, Apparent>): void;
}

/** How a thing is seen with slow light (D41): how late its light is, and how it was moving then. Reused. */
export interface Seen {
  /** How late its light is, ms, without the interpolation delay: its state is shown from `now − lateMs`. */
  lateMs: number;
  /** Its velocity when the light left, tiles/s. */
  vx: number;
  vy: number;
}

/** One peer's pieces, kept while they have a position. */
interface PeerRecord {
  bob: Bob;
  sprite: Sprite;
  label: PeerLabel;
  lighter: { key: string; x: number; y: number };
  headlight: { key: string; x: number; y: number; angle: number };
}

/** The ball as this client shows it: where it is predicted, its mood and how high it is drawn (BallPrediction). */
export type ShownBall = Pick<BallPrediction, 'ball' | 'mood' | 'lift' | 'heldBy' | 'holdAt'>;

const MODELS: Record<ObjectKind, VoxelModel> = { vacuum: VACUUM_MODEL, ball: BALL_MODEL, scooter: SCOOTER_MODEL };

/** An object's pose to draw, with how high above the floor (only the ball's hop lifts one). */
interface ObjectPose extends PlayerState {
  lift: number;
}

const BALL_LOOK_SETTLE_MS = 20;
const BALL_LOOK_CAPACITY = 400;
/** A seen velocity is the move over this long before the light left: two server ticks, so one late tick doesn't jolt it. */
export const VELOCITY_WINDOW_MS = 150;
/** Who held the ball, by stamped change: few within a light time. */
const HOLDER_CAPACITY = 16;

/** Something the session dropped, still drawn until its leaving's light reaches the eye. */
interface Departed<T> {
  thing: T;
  goneAt: number;
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
  const headlights: HeadlightSource[] = [];
  const voxels: VoxelInstance[] = [];
  const at = { x: 0, y: 0, angle: 0 };
  let atLift = 0;
  /** Where the ball was shown, frame by frame: with slow light it is drawn from here, as late as its light. */
  const ballTrail = createTrail();
  /**
   * How the ball looked, frame by frame: x its lift, y how strongly it trembled (0..1). Finer than its trail, since a
   * hop lasts under half a second; 400 entries keep the 8 s light takes to cross the room at the slowest c.
   */
  const ballLookTrail = createTrail(BALL_LOOK_SETTLE_MS, BALL_LOOK_CAPACITY);
  const ballLook = { x: 0, y: 0, angle: 0 };
  const ballSeenAt = { x: 0, y: 0 };
  let ballSeen: Point | null = null;

  // Slow light's seen things (D41). Off, none of these is filled and everything reads the session's live state.
  let lightOn = false;
  const seen = new Map<string, Seen>();
  /** Each peer's look, stamped as it changed, and the one seen this frame. */
  const looks = new Map<string, StateRing<PeerLook>>();
  const seenLooks = new Map<string, PeerLook>();
  const liveNow = { held: null, boombox: false, riding: null, mic: false, gesture: null } as PeerLook;
  /** When each peer's seen state is from: `now − lateMs`, or `now` with slow light off. */
  const seenNows = new Map<string, number>();
  const departedPeers = new Map<string, Departed<RemotePeer>>();
  const departedObjects = new Map<string, Departed<RemoteObject>>();
  /** The session's peers and objects last sample, so a leaver's record outlives the session's. */
  const peerRefs = new Map<string, RemotePeer>();
  const objectRefs = new Map<string, RemoteObject>();
  const holders = createStateRing<{ by: string | null }>(
    HOLDER_CAPACITY,
    () => ({ by: null }),
    (from, to) => {
      to.by = from.by;
    },
    (a, b) => a.by === b.by
  );
  const holderNow = { by: null as string | null };
  const before = { x: 0, y: 0, angle: 0 };
  /** The last sample's slow light: the eye and c a thing's own motion is judged from. */
  let lastLight: SeenLight | null = null;
  const ownMotion = { shift: 0, turn: 0 };

  /**
   * How a thing's own motion changes its look (D41): its Doppler shift and its model's Terrell turn, judged where its
   * image is (through a portal, its velocity turned with it). Nothing at rest or with slow light off.
   */
  const seeOwnMotion = (key: string, pos: Point, image: Apparent | undefined) => {
    ownMotion.shift = 0;
    ownMotion.turn = 0;
    const record = lastLight === null ? undefined : seen.get(key);
    if (lastLight === null || record === undefined || (record.vx === 0 && record.vy === 0)) {
      return ownMotion;
    }
    const cos = image?.cos ?? 1;
    const sin = image?.sin ?? 0;
    const vx = record.vx * cos - record.vy * sin;
    const vy = record.vx * sin + record.vy * cos;
    const dx = lastLight.eye.x - (image?.x ?? pos.x);
    const dy = lastLight.eye.y - (image?.y ?? pos.y);
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-6) {
      return ownMotion;
    }
    const c = lastLight.lightSpeed;
    ownMotion.shift = shiftSteps(sourceDoppler(vx, vy, dx / distance, dy / distance, c));
    ownMotion.turn = terrellTurn(vx, vy, dx / distance, dy / distance, c);
    return ownMotion;
  };

  /** The seen record of `key`, made once. */
  const seenRecord = (key: string): Seen => {
    let record = seen.get(key);
    if (!record) {
      record = { lateMs: 0, vx: 0, vy: 0 };
      seen.set(key, record);
    }
    return record;
  };

  /** The velocity when the light left, from the pose in `at` and the buffer a moment before; 0 across a portal. */
  const seeMotion = (record: Seen, buffer: Pick<SnapshotBuffer, 'sample'>, lightLeftAt: number) => {
    record.vx = 0;
    record.vy = 0;
    if (!buffer.sample(lightLeftAt - VELOCITY_WINDOW_MS, before)) {
      return;
    }
    const dx = at.x - before.x;
    const dy = at.y - before.y;
    if (Math.hypot(dx, dy) <= JUMP_TILES) {
      record.vx = (dx * 1000) / VELOCITY_WINDOW_MS;
      record.vy = (dy * 1000) / VELOCITY_WINDOW_MS;
    }
  };

  /**
   * Samples `buffer` into `at` as it is seen from `drawnAt` (the time it would be drawn at with instant light), and
   * returns the time its state is seen from: `now` with instant light, NaN with nothing to draw. A thing that arrived
   * at `since` or left at `goneAt` is drawn only while the eye sees it there.
   */
  const sampleSeen = (
    key: string,
    buffer: SnapshotBuffer,
    now: number,
    drawnAt: number,
    light: SeenLight | null,
    since = Number.NEGATIVE_INFINITY,
    goneAt = Number.POSITIVE_INFINITY
  ): number => {
    if (light === null) {
      return buffer.sample(drawnAt, at) ? now : Number.NaN;
    }
    const lightLeftAt = seenAt(buffer, light, drawnAt, at);
    if (Number.isNaN(lightLeftAt)) {
      return Number.NaN;
    }
    const record = seenRecord(key);
    record.lateMs = drawnAt - lightLeftAt;
    const seenNow = now - record.lateMs;
    if (seenNow < since || seenNow >= goneAt) {
      return Number.NaN;
    }
    seeMotion(record, buffer, lightLeftAt);
    return seenNow;
  };

  const forgetPosition = (key: string) => {
    positions.delete(key);
    headings.delete(key);
    objectPoses.delete(key);
    seen.delete(key);
    seenNows.delete(key);
  };

  /** Keeps leavers drawn while slow light is on; forgets the rest the session no longer has. */
  const noteDepartures = (s: Session, now: number) => {
    for (const [id, obj] of objectRefs) {
      if (!s.objects.has(id)) {
        objectRefs.delete(id);
        if (lightOn && obj.info.kind !== 'ball') {
          departedObjects.set(id, { thing: obj, goneAt: now });
        }
      }
    }
    for (const [id, peer] of peerRefs) {
      if (!s.peers.has(id)) {
        peerRefs.delete(id);
        if (lightOn) {
          departedPeers.set(id, { thing: peer, goneAt: now });
        }
      }
    }
    for (const obj of s.objects.values()) {
      objectRefs.set(obj.info.id, obj);
      departedObjects.delete(obj.info.id);
    }
    for (const peer of s.peers.values()) {
      peerRefs.set(peer.info.id, peer);
      departedPeers.delete(peer.info.id);
    }
    if (!lightOn) {
      departedObjects.clear();
      departedPeers.clear();
      looks.clear();
      holders.clear();
    }
  };

  const forgetGone = () => {
    for (const [id, key] of objectKeys) {
      if (!objectRefs.has(id) && !departedObjects.has(id)) {
        objectKeys.delete(id);
        forgetPosition(key);
      }
    }
    for (const id of positions.keys()) {
      if (!peerRefs.has(id) && !departedPeers.has(id) && !objectPoses.has(id)) {
        forgetPosition(id);
        looks.delete(id);
        seenLooks.delete(id);
      }
    }
  };

  const shake = { x: 0, y: 0 };
  /** Who dribbles the ball, as seen from the last sample: their items are put away. */
  let dribbler: string | null = null;

  /** A dribbled ball is drawn from its dribbler's drawn pose, so the two can't drift apart. */
  const placeHeldBall = (shown: ShownBall | null) => {
    const ball = shown?.ball ?? null;
    const at = dribbler === null ? undefined : positions.get(dribbler);
    const key = ball === null ? undefined : objectKeys.get(ball.id);
    const pose = key === undefined ? undefined : objectPoses.get(key);
    if (dribbler !== null && at && pose) {
      shown?.holdAt(at.x, at.y, headings.get(dribbler) ?? 0, pose);
    }
  };
  /**
   * Puts where the ball is seen in `at` and its tremble in `shake`, and returns its lift: with `light`, all as late as
   * its light, and who held it then. A ball the local player holds is at their hand in the present.
   */
  const seeBall = (s: Session, ball: Point, shown: ShownBall | null, now: number, light: SeenLight | null): number => {
    const mood = shown?.mood ?? 'asleep';
    const lift = shown?.lift ?? 0;
    const holder = shown?.heldBy ?? null;
    const heldByLocalPlayer = holder !== null && !s.peers.has(holder);
    if (light === null || heldByLocalPlayer) {
      dribbler = holder;
      at.x = ball.x;
      at.y = ball.y;
      ballShake(mood, now, shake);
      return lift;
    }
    ballTrail.push(now, ball.x, ball.y, 0);
    const lightLeftAt = seenAt(ballTrail.buffer, light, now, at);
    const record = seenRecord(objectKey(shown?.ball?.id ?? ''));
    record.lateMs = now - lightLeftAt;
    seeMotion(record, ballTrail.buffer, lightLeftAt);
    holderNow.by = holder;
    holders.push(now, holderNow);
    dribbler = holders.at(lightLeftAt).by;
    ballLookTrail.push(now, lift, mood === 'scared' ? 1 : 0, 0);
    ballLookTrail.buffer.sample(lightLeftAt, ballLook);
    ballShake('scared', lightLeftAt, shake);
    const tremble = dribbler === null ? ballLook.y : 0;
    shake.x *= tremble;
    shake.y *= tremble;
    return ballLook.x;
  };

  /** Writes `at` and `atLift` as the pose of object `id`. */
  const placeObject = (id: string) => {
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
  };

  const sampleObject = (obj: RemoteObject, now: number, light: SeenLight | null, goneAt?: number) => {
    const id = obj.info.id;
    // Objects come every tick; each peer is drawn as late as its updates need (6d spec §2.3).
    const key = objectKeys.get(id) ?? objectKey(id);
    if (Number.isNaN(sampleSeen(key, obj.buffer, now, now - INTERP_DELAY_MS, light, obj.since, goneAt))) {
      const known = objectKeys.get(id);
      if (known !== undefined) {
        forgetPosition(known);
      }
      if (goneAt !== undefined) {
        departedObjects.delete(id);
      }
      return;
    }
    atLift = 0;
    placeObject(id);
  };

  const sampleObjects = (s: Session, now: number, shown: ShownBall | null, light: SeenLight | null) => {
    const ball = shown?.ball ?? null;
    ballSeen = null;
    for (const obj of s.objects.values()) {
      if (obj.info.kind !== 'ball') {
        sampleObject(obj, now, light);
        continue;
      }
      if (ball?.id !== obj.info.id) {
        continue;
      }
      atLift = seeBall(s, ball, shown, now, light);
      ballSeenAt.x = at.x;
      ballSeenAt.y = at.y;
      ballSeen = ballSeenAt;
      at.x += shake.x;
      at.y += shake.y;
      // Its pattern rolls in world axes (models/ball.ts), so the model itself never turns.
      at.angle = 0;
      placeObject(obj.info.id);
    }
    for (const { thing, goneAt } of departedObjects.values()) {
      sampleObject(thing, now, light, goneAt);
    }
  };

  /** The look a peer is seen with: as late as its light, or live. */
  const lookOf = (peer: RemotePeer): PeerLook =>
    (lightOn ? seenLooks.get(peer.info.id) : undefined) ?? liveLook(peer, liveNow);

  /** Stamps a peer's live look and keeps the one seen at `seenNow`. */
  const seeLook = (peer: RemotePeer, now: number, seenNow: number) => {
    const id = peer.info.id;
    let ring = looks.get(id);
    if (!ring) {
      ring = createLookRing();
      looks.set(id, ring);
    }
    ring.push(now, liveLook(peer, liveNow));
    seenLooks.set(id, ring.at(seenNow));
  };

  const samplePeer = (
    peer: RemotePeer,
    player: Point,
    now: number,
    portals: Portals | null,
    light: SeenLight | null,
    goneAt?: number
  ) => {
    const id = peer.info.id;
    const delay = peer.delay.update(now, nearTier(portals, player, peer.info.x, peer.info.y));
    const seenNow = sampleSeen(id, peer.buffer, now, now - delay, light, peer.since, goneAt);
    if (light !== null) {
      seeLook(peer, now, Number.isNaN(seenNow) ? now : seenNow);
    }
    if (Number.isNaN(seenNow)) {
      forgetPosition(id);
      if (goneAt !== undefined) {
        departedPeers.delete(id);
      }
      return;
    }
    seenNows.set(id, seenNow);
    const pos = positions.get(id);
    if (pos) {
      pos.x = at.x;
      pos.y = at.y;
    } else {
      positions.set(id, { x: at.x, y: at.y });
    }
    headings.set(id, at.angle);
  };

  const samplePeers = (s: Session, player: Point, now: number, portals: Portals | null, light: SeenLight | null) => {
    for (const peer of s.peers.values()) {
      samplePeer(peer, player, now, portals, light);
    }
    for (const { thing, goneAt } of departedPeers.values()) {
      samplePeer(thing, player, now, portals, light, goneAt);
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
        headlight: { key: id, x: 0, y: 0, angle: 0 },
      };
      records.set(id, record);
    }
    return record;
  };

  let drawn = 0;
  let lit = 0;
  let riders = 0;
  const collectPeer = (
    peer: RemotePeer,
    media: PeerMedia,
    now: number,
    dt: number,
    apparent: ReadonlyMap<string, Apparent> | undefined
  ) => {
    const id = peer.info.id;
    const pos = positions.get(id);
    if (!pos) {
      return;
    }
    const look = lookOf(peer);
    const { bob, sprite, label, lighter, headlight } = recordOf(id);
    bob.update(pos.x, pos.y, dt);
    // Both hands are on the handlebar while riding, or on the ball while dribbling: the lighter is put away.
    const handsFull = look.riding !== null || id === dribbler;
    if (look.held === 'lighter' && !handsFull) {
      lighter.x = pos.x;
      lighter.y = pos.y;
      lighters[lit++] = lighter;
    }
    if (look.riding !== null) {
      headlight.x = pos.x;
      headlight.y = pos.y;
      headlight.angle = headings.get(id) ?? 0;
      headlights[riders++] = headlight;
    }
    const seenNow = lightOn ? (seenNows.get(id) ?? now) : now;
    fillSprite(sprite, peer, look, pos, bob, media, seenNow, handsFull);
    sprite.shift = seeOwnMotion(id, pos, apparent?.get(id)).shift;
    fillLabel(label, peer, look, pos, apparent?.get(id) ?? pos);
    sprites[drawn] = sprite;
    labels[drawn] = label;
    drawn++;
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
    drawn = 0;
    lit = 0;
    riders = 0;
    for (const peer of s.peers.values()) {
      collectPeer(peer, media, now, dt, apparent);
    }
    for (const { thing } of departedPeers.values()) {
      collectPeer(thing, media, now, dt, apparent);
    }
    // Written by index and trimmed: `length = 0` would make V8 drop the arrays' storage every frame.
    sprites.length = drawn;
    labels.length = drawn;
    lighters.length = lit;
    headlights.length = riders;
  };

  /** Puts a model at `voxels[n]`, reusing the instance there. */
  const placeVoxel = (n: number, model: VoxelModel, x: number, y: number, angle: number, lift: number) => {
    const v = voxels.at(n) ?? { model, x: 0, y: 0, angle: 0, lift: 0 };
    v.model = model;
    v.x = x;
    v.y = y;
    v.angle = angle;
    v.lift = lift;
    v.shift = ownMotion.shift;
    v.turn = ownMotion.turn;
    voxels[n] = v;
  };

  let models = 0;
  const collectObject = (obj: RemoteObject, apparent: ReadonlyMap<string, Apparent> | undefined) => {
    const key = objectKeys.get(obj.info.id);
    const pose = key === undefined ? undefined : objectPoses.get(key);
    if (key !== undefined && pose) {
      seeOwnMotion(key, pose, apparent?.get(key));
      placeVoxel(models++, MODELS[obj.info.kind], pose.x, pose.y, pose.angle, pose.lift);
    }
  };
  /** A ridden scooter is drawn from its rider's own drawn pose, so the two can't drift apart. */
  const collectRide = (peer: RemotePeer, apparent: ReadonlyMap<string, Apparent> | undefined) => {
    const pos = lookOf(peer).riding === null ? undefined : positions.get(peer.info.id);
    if (pos) {
      seeOwnMotion(peer.info.id, pos, apparent?.get(peer.info.id));
      placeVoxel(models++, RIDDEN_SCOOTER_MODEL, pos.x, pos.y, headings.get(peer.info.id) ?? 0, 0);
    }
  };

  const collectVoxels = (s: Session, apparent: ReadonlyMap<string, Apparent> | undefined) => {
    models = 0;
    for (const obj of s.objects.values()) {
      collectObject(obj, apparent);
    }
    for (const { thing } of departedObjects.values()) {
      collectObject(thing, apparent);
    }
    for (const peer of s.peers.values()) {
      collectRide(peer, apparent);
    }
    for (const { thing } of departedPeers.values()) {
      collectRide(thing, apparent);
    }
    voxels.length = models;
  };

  return {
    positions,
    get ballSeen() {
      return ballSeen;
    },
    objectPoses,
    sprites,
    labels,
    voxels,
    lighters,
    headlights,
    seenOf: (key) => (lightOn ? seen.get(key) : undefined),
    sample(s, player, now, ball = null, portals = null, light = null) {
      lightOn = light !== null;
      lastLight = light;
      noteDepartures(s, now);
      forgetGone();
      sampleObjects(s, now, ball, light);
      samplePeers(s, player, now, portals, light);
      placeHeldBall(ball);
    },
    collect(s, media, now, dt, apparent) {
      collectPeers(s, media, now, dt, apparent);
      collectVoxels(s, apparent);
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
function fillSprite(
  sprite: Sprite,
  peer: RemotePeer,
  look: PeerLook,
  pos: Point,
  bob: Bob,
  media: PeerMedia,
  seenNow: number,
  handsFull: boolean
): void {
  const { id, color } = peer.info;
  const { held, boombox, gesture } = look;
  sprite.x = pos.x;
  sprite.y = pos.y;
  sprite.color = ringRgb(color);
  sprite.face = media.faceOf(id);
  sprite.speaking = media.speaking(id);
  // A rider glides on the deck: no step.
  const riding = look.riding !== null;
  sprite.bob = riding ? 0 : bob.lift;
  sprite.itemBob = riding ? 0 : bob.itemLift;
  sprite.ride = riding ? SCOOTER_DECK_TILES : 0;
  // The sprite's sip, cheers and wobble are a HeldPose. The lighter has no gestures: one under way when it was taken
  // stops.
  const shown = gesture && isDrink(held) && seenNow >= gesture.at ? gesture : null;
  gesturePose(shown ? shown.kind : null, shown ? seenNow - shown.at : 0, sprite);
  sprite.held = handsFull ? null : held;
  sprite.boombox = handsFull ? false : boombox;
}

function fillLabel(label: PeerLabel, peer: RemotePeer, look: PeerLook, pos: Point, shown: Point): void {
  label.x = pos.x;
  label.y = pos.y;
  label.shownX = shown.x;
  label.shownY = shown.y;
  label.color = peer.info.color;
  label.name = peer.info.name;
  label.mic = look.mic;
}
