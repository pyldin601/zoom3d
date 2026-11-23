import {
  type Ball,
  type BallMood,
  createBall,
  INTERP_DELAY_MS,
  LEVEL1,
  type ObjectInfo,
  type PeerInfo,
  parseMap,
  SnapshotBuffer,
  wirePortals,
} from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { FAR_DELAY_MS, PeerDelay } from '../net/peer-delay';
import { objectKey, type RemoteObject, type RemotePeer, type Session } from '../net/session';
import { BALL_MODEL } from '../renderer/models/ball';
import { RIDDEN_SCOOTER_MODEL, SCOOTER_DECK_TILES, SCOOTER_MODEL } from '../renderer/models/scooter';
import { VACUUM_MODEL } from '../renderer/models/vacuum';
import { hexToRgb } from '../renderer/sprites';
import type { SeenLight } from './light-delay';
import { createRemoteWorld, type PeerMedia, type ShownBall } from './remote-world';

const NOW = 10_000;
const player = { x: 0, y: 0 };
const shown = (ball: Ball, mood: BallMood = 'asleep', lift = 0, heldBy: string | null = null): ShownBall => ({
  ball,
  mood,
  lift,
  heldBy,
  holdAt: (x, y, angle, out) => {
    out.x = x + Math.cos(angle);
    out.y = y + Math.sin(angle);
    return out;
  },
});
const FACE = new Uint32Array(4);
const media: PeerMedia = { faceOf: (id) => (id === 'ada' ? FACE : null), speaking: (id) => (id === 'ada' ? 0.5 : 0) };

const info = (id: string, x: number, y: number): PeerInfo => ({
  id,
  slot: 0,
  name: id,
  color: '#ff0000',
  x,
  y,
  angle: 0,
  cam: true,
  mic: id !== 'bob',
  avatar: null,
  held: 'beer',
  boombox: false,
  riding: null,
});

/** A session whose peers and objects stand still where given. */
function fakeSession() {
  const peers = new Map<string, RemotePeer>();
  const objects = new Map<string, RemoteObject>();
  const standing = (x: number, y: number, angle = 0) => {
    const buffer = new SnapshotBuffer();
    buffer.push({ t: 0, x, y, angle });
    return buffer;
  };
  return {
    session: { peers, objects } as unknown as Session,
    addPeer(id: string, x: number, y: number) {
      peers.set(id, { info: info(id, x, y), buffer: standing(x, y), delay: new PeerDelay(), gesture: null });
    },
    addObject(id: string, x: number, y: number, angle: number, kind: ObjectInfo['kind'] = 'vacuum') {
      const objectInfo: ObjectInfo = { id, kind, x, y, angle };
      objects.set(id, { info: objectInfo, buffer: standing(x, y, angle), lastSeq: 0 });
    },
    peers,
    objects,
  };
}

let room: ReturnType<typeof fakeSession>;
beforeEach(() => {
  room = fakeSession();
});

describe('sample', () => {
  test('places every peer, by id, and every object, by objectKey', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    room.addObject('v1', 4, 5, 1);
    world.sample(room.session, player, NOW);
    expect(world.positions.get('ada')).toEqual({ x: 2, y: 3 });
    expect(world.positions.get(objectKey('v1'))).toEqual({ x: 4, y: 5, angle: 1, lift: 0 });
    expect(world.objectPoses.get(objectKey('v1'))).toBe(world.positions.get(objectKey('v1')));
  });

  test('forgets peers and objects the session no longer has', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    room.addObject('v1', 4, 5, 1);
    world.sample(room.session, player, NOW);
    room.peers.delete('ada');
    room.objects.delete('v1');
    world.sample(room.session, player, NOW);
    expect(world.positions.size).toBe(0);
    expect(world.objectPoses.size).toBe(0);
  });

  test('moves the same position objects from sample to sample', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    world.sample(room.session, player, NOW);
    const first = world.positions.get('ada');
    room.peers.get('ada')?.buffer.push({ t: NOW, x: 6, y: 3, angle: 0 });
    world.sample(room.session, player, NOW + 1000);
    expect(world.positions.get('ada')).toBe(first);
    expect(first).toEqual({ x: 6, y: 3 });
  });
  test('draws a peer far on the map but near through a portal with the near delay, as the server sends it', () => {
    const portals = wirePortals(parseMap(LEVEL1), 'AAAAAAAAAAAAAAAAAAAAAA');
    const pair = portals.list
      .map((portal) => ({ portal, other: portals.list.at(portal.to) }))
      .find(({ portal, other }) => other && Math.hypot(portal.cx - other.cx, portal.cy - other.cy) > 20);
    if (!pair?.other) {
      throw new Error('level1 has no pair of doorways far apart');
    }
    const { portal, other } = pair;
    const eye = { x: portal.cx - portal.nx, y: portal.cy - portal.ny };
    room.addPeer('ada', other.cx + other.nx, other.cy + other.ny);
    const delay = room.peers.get('ada')?.delay;

    createRemoteWorld().sample(room.session, eye, NOW, null, portals);
    expect(delay?.value).toBe(INTERP_DELAY_MS);

    room.addPeer('ada', other.cx + other.nx, other.cy + other.ny);
    createRemoteWorld().sample(room.session, eye, NOW);
    expect(room.peers.get('ada')?.delay.value).toBe(FAR_DELAY_MS);
  });
});

describe('slow light (D39)', () => {
  const OPEN = parseMap(
    ['11111111111111111111', ...Array.from({ length: 8 }, () => `1${'.'.repeat(18)}1`), '11111111111111111111']
      .join('\n')
      .replace('.', 'S')
  );
  const eye = { x: 2, y: 2 };
  const slow = (lightSpeed = 12): SeenLight => ({ map: OPEN, portals: null, eye, lightSpeed });
  /** A walk along x from (2, 2) at 6 tiles/s, half of c, ending at (14, 2) at `endT`, sent every 66 ms. */
  const walkTo14 = (buffer: SnapshotBuffer, endT: number) => {
    for (let t = endT - 2000; t <= endT; t += 66) {
      buffer.push({ t, x: 14 - (6 * (endT - t)) / 1000, y: 2, angle: 0 });
    }
    buffer.push({ t: endT, x: 14, y: 2, angle: 0 });
  };

  test('a far peer that stopped a moment ago is still drawn on its way, where its light left it', () => {
    room.addPeer('ada', 2, 2);
    walkTo14(room.peers.get('ada')?.buffer as SnapshotBuffer, NOW - 600);
    const world = createRemoteWorld();
    world.sample(room.session, eye, NOW, null, null);
    expect(world.positions.get('ada')?.x).toBeCloseTo(14, 6);
    world.sample(room.session, eye, NOW, null, null, slow());
    expect(world.positions.get('ada')?.x).toBeLessThan(13);
  });

  test('the vacuum is drawn late too', () => {
    room.addObject('v1', 2, 2, 0);
    walkTo14(room.objects.get('v1')?.buffer as SnapshotBuffer, NOW - 600);
    const world = createRemoteWorld();
    world.sample(room.session, eye, NOW, null, null, slow());
    expect(world.positions.get(objectKey('v1'))?.x).toBeLessThan(13);
  });

  test('at 144 Hz a far rolling ball is still drawn as late as its light', () => {
    room.addObject('b1', 2, 2, 0, 'ball');
    const world = createRemoteWorld();
    // Still at (14, 2), 12 tiles off, for 3 s: at c = 6 its light takes 2 s, then it rolls on at 6 tiles/s.
    for (let t = NOW - 3000; t <= NOW; t += 7) {
      const x = t < NOW - 1000 ? 14 : 14 + (6 * (t - (NOW - 1000))) / 1000;
      world.sample(room.session, eye, t, shown(createBall('b1', x, 2)), null, slow(6));
    }
    expect(world.positions.get(objectKey('b1'))?.x).toBeCloseTo(14, 1);
  });

  /** A ball still at (14, 2), 12 tiles off: at c = 6 its light takes 2 s. `look` gives its mood and lift at t. */
  const still14 = (world: ReturnType<typeof createRemoteWorld>, look: (t: number) => [BallMood, number]) => {
    room.addObject('b1', 2, 2, 0, 'ball');
    for (let t = NOW - 4000; t <= NOW; t += 7) {
      const [mood, lift] = look(t);
      world.sample(room.session, eye, t, shown(createBall('b1', 14, 2), mood, lift), null, slow(6));
    }
  };

  test('a far ball’s hop is seen as late as its light', () => {
    const world = createRemoteWorld();
    still14(world, (t) => ['asleep', t < NOW - 500 ? 0 : 0.3]);
    expect(world.objectPoses.get(objectKey('b1'))).toMatchObject({ lift: 0 });
  });

  test('a far ball’s tremble is seen as late as its light', () => {
    const world = createRemoteWorld();
    still14(world, (t) => [t < NOW - 500 ? 'asleep' : 'scared', 0]);
    expect(world.objectPoses.get(objectKey('b1'))).toMatchObject({ x: 14, y: 2 });
  });

  test('the ball is seen where its light left it, without its tremble: its pattern rolls by that', () => {
    const world = createRemoteWorld();
    room.addObject('b1', 2, 2, 0, 'ball');
    world.sample(room.session, eye, NOW, shown(createBall('b1', 5, 2), 'scared'), null, null);
    expect(world.ballSeen).toEqual({ x: 5, y: 2 });
    for (let t = NOW; t <= NOW + 2000; t += 16) {
      const x = 14 - (6 * (NOW + 2000 - t)) / 1000;
      world.sample(room.session, eye, t, shown(createBall('b1', x, 2), 'scared'), null, slow());
    }
    expect(world.ballSeen?.x).toBeLessThan(13);
    expect(world.ballSeen?.y).toBe(2);
  });

  test('a rolling ball is drawn where it was; a held one in the present', () => {
    room.addObject('b1', 2, 2, 0, 'ball');
    const world = createRemoteWorld();
    for (let t = NOW - 2000; t <= NOW; t += 16) {
      world.sample(room.session, eye, t, shown(createBall('b1', 14 - (6 * (NOW - t)) / 1000, 2)), null, slow());
    }
    expect(world.positions.get(objectKey('b1'))?.x).toBeLessThan(13);
    world.sample(room.session, eye, NOW, shown(createBall('b1', 14, 2), 'asleep', 0, 'me'), null, slow());
    expect(world.positions.get(objectKey('b1'))?.x).toBeCloseTo(14, 6);
  });

  describe('seen state (D41): at c = 6, someone 6 tiles off is seen a second late', () => {
    const peer = (id: string) => room.peers.get(id) as RemotePeer;
    /** Samples and collects at `t` with slow light at c = 6. */
    const frame = (world: ReturnType<typeof createRemoteWorld>, t: number, ball: ShownBall | null = null) => {
      world.sample(room.session, eye, t, ball, null, slow(6));
      world.collect(room.session, media, t, 0);
    };

    test('a lighter switched on now is seen only once its light arrives', () => {
      const world = createRemoteWorld();
      room.addPeer('ada', 8, 2);
      frame(world, NOW);
      peer('ada').info.held = 'lighter';
      frame(world, NOW + 16);
      frame(world, NOW + 500);
      expect(world.lighters).toEqual([]);
      expect(world.sprites.at(0)).toMatchObject({ held: 'beer' });
      frame(world, NOW + 1100);
      expect(world.lighters).toMatchObject([{ key: 'ada' }]);
      expect(world.sprites.at(0)).toMatchObject({ held: 'lighter' });
    });

    test('the mic badge and the boombox change as late as the light', () => {
      const world = createRemoteWorld();
      room.addPeer('ada', 8, 2);
      frame(world, NOW);
      peer('ada').info.mic = false;
      peer('ada').info.boombox = true;
      frame(world, NOW + 500);
      expect(world.labels.at(0)).toMatchObject({ mic: true });
      expect(world.sprites.at(0)).toMatchObject({ boombox: false });
      frame(world, NOW + 1600);
      expect(world.labels.at(0)).toMatchObject({ mic: false });
      expect(world.sprites.at(0)).toMatchObject({ boombox: true });
    });

    test('a sip is played from when its light arrives', () => {
      const world = createRemoteWorld();
      room.addPeer('ada', 8, 2);
      frame(world, NOW);
      peer('ada').gesture = { kind: 'sip', at: NOW };
      frame(world, NOW + 16);
      frame(world, NOW + 900);
      expect(world.sprites.at(0)).toMatchObject({ sip: 0 });
      frame(world, NOW + 1400);
      expect(world.sprites.at(0)?.sip).toBeGreaterThan(0);
    });

    test('someone who joins now is unseen until their light arrives; someone from the welcome at once', () => {
      const world = createRemoteWorld();
      room.addPeer('ada', 8, 2);
      room.addPeer('bob', 8, 3);
      peer('bob').since = NOW;
      frame(world, NOW + 500);
      expect([...world.positions.keys()]).toEqual(['ada']);
      frame(world, NOW + 1100);
      expect(world.positions.has('bob')).toBe(true);
    });

    test('someone who left is drawn until their light passes, then forgotten', () => {
      const world = createRemoteWorld();
      room.addPeer('ada', 8, 2);
      room.addObject('v1', 8, 3, 0);
      frame(world, NOW);
      room.peers.delete('ada');
      room.objects.delete('v1');
      frame(world, NOW + 16);
      frame(world, NOW + 500);
      expect(world.sprites.map((s) => s.key)).toEqual(['ada']);
      expect(world.voxels.map((v) => v.model)).toEqual([VACUUM_MODEL]);
      frame(world, NOW + 1200);
      expect(world.sprites).toEqual([]);
      expect(world.voxels).toEqual([]);
      expect(world.positions.size).toBe(0);
    });

    test('stepping on a scooter swaps the parked one for the ridden one at one light time', () => {
      const world = createRemoteWorld();
      room.addObject('s1', 8, 2, 0, 'scooter');
      room.addPeer('ada', 8, 2);
      frame(world, NOW);
      room.objects.delete('s1');
      peer('ada').info.riding = 's1';
      frame(world, NOW + 16);
      frame(world, NOW + 500);
      expect(world.voxels.map((v) => v.model)).toEqual([SCOOTER_MODEL]);
      frame(world, NOW + 1100);
      expect(world.voxels.map((v) => v.model)).toEqual([RIDDEN_SCOOTER_MODEL]);
      expect(world.headlights).toMatchObject([{ key: 'ada' }]);
    });

    test('a ball picked up is seen loose until the pickup’s light arrives, then at the hand', () => {
      const world = createRemoteWorld();
      room.addPeer('ada', 8, 2);
      room.addObject('b1', 8, 4, 0, 'ball');
      for (let t = NOW - 2000; t < NOW; t += 16) {
        frame(world, t, shown(createBall('b1', 10, 3)));
      }
      // Held from NOW: the prediction puts it at ada's hand, (9, 2).
      for (let t = NOW; t <= NOW + 2500; t += 16) {
        frame(world, t, shown(createBall('b1', 9, 2), 'asleep', 0, 'ada'));
        if (t === NOW + 496) {
          expect(world.positions.get(objectKey('b1'))).toMatchObject({ x: 10, y: 3 });
          expect(world.sprites.at(0)).toMatchObject({ held: 'beer' });
        }
      }
      expect(world.positions.get(objectKey('b1'))).toMatchObject({ x: 9, y: 2 });
      expect(world.sprites.at(0)).toMatchObject({ held: null });
    });

    test('someone walking toward the eye is shifted up, away down, and a crossing scooter is turned', () => {
      const world = createRemoteWorld();
      room.addPeer('ada', 8, 2);
      room.addPeer('bob', 8, 3);
      room.addObject('s1', 8, 6, 0, 'scooter');
      const walk = (buffer: SnapshotBuffer, x0: number, y0: number, vx: number, vy: number) => {
        for (let t = NOW - 1900; t <= NOW; t += 66) {
          buffer.push({ t, x: x0 + (vx * (t - NOW)) / 1000, y: y0 + (vy * (t - NOW)) / 1000, angle: 0 });
        }
      };
      walk(peer('ada').buffer, 8, 2, -2, 0);
      walk(peer('bob').buffer, 8, 3, 2, 0);
      walk(room.objects.get('s1')?.buffer as SnapshotBuffer, 8, 6, 3, 0);
      frame(world, NOW);
      expect(world.sprites.find((s) => s.key === 'ada')?.shift).toBeGreaterThan(0);
      expect(world.sprites.find((s) => s.key === 'bob')?.shift).toBeLessThan(0);
      const scooter = world.voxels.find((v) => v.model === SCOOTER_MODEL);
      expect(scooter?.turn).not.toBe(0);
      expect(scooter?.shift).toBeLessThan(0);
      world.sample(room.session, eye, NOW, null, null, null);
      world.collect(room.session, media, NOW, 0);
      expect(world.sprites.map((s) => s.shift ?? 0)).toEqual([0, 0]);
      expect(world.voxels.map((v) => v.turn ?? 0)).toEqual([0]);
    });

    test('off, the live state shows at once', () => {
      const world = createRemoteWorld();
      room.addPeer('ada', 8, 2);
      frame(world, NOW);
      peer('ada').info.held = 'lighter';
      frame(world, NOW + 16);
      world.sample(room.session, eye, NOW + 32, null, null, null);
      world.collect(room.session, media, NOW + 32, 0);
      expect(world.lighters).toMatchObject([{ key: 'ada' }]);
    });
  });
});

describe('collect', () => {
  test('a peer holding the lighter is listed among the lighters, where they stand and face', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    room.addPeer('bob', 5, 3);
    const ada = room.peers.get('ada');
    if (!ada) {
      throw new Error('no ada');
    }
    ada.info.held = 'lighter';
    ada.buffer = new SnapshotBuffer();
    ada.buffer.push({ t: 0, x: 2, y: 3, angle: 1.2 });
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    expect(world.lighters).toEqual([{ key: 'ada', x: 2, y: 3 }]);
    ada.info.held = null;
    world.collect(room.session, media, NOW, 0);
    expect(world.lighters).toEqual([]);
  });

  test('one disc and one label per placed peer, with their face, ring, voice and drink', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    room.addPeer('bob', 7, 1);
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    expect(world.sprites.map((s) => [s.key, s.x, s.y])).toEqual([
      ['ada', 2, 3],
      ['bob', 7, 1],
    ]);
    expect(world.sprites.at(0)).toMatchObject({ face: FACE, speaking: 0.5, color: hexToRgb('#ff0000'), held: 'beer' });
    expect(world.sprites.at(1)).toMatchObject({ face: null, speaking: 0 });
    expect(world.labels).toEqual([
      { x: 2, y: 3, shownX: 2, shownY: 3, color: '#ff0000', name: 'ada', mic: true },
      { x: 7, y: 1, shownX: 7, shownY: 1, color: '#ff0000', name: 'bob', mic: false },
    ]);
  });

  test('a label is shown at the apparent position and keeps the real one for the automap', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    world.sample(room.session, player, NOW);
    const apparent = new Map([['ada', { x: 9, y: 8, sees: true, through: 1 as const, cos: 1, sin: 0 }]]);
    world.collect(room.session, media, NOW, 0, apparent);
    expect(world.labels.at(0)).toMatchObject({ x: 2, y: 3, shownX: 9, shownY: 8 });
    expect(world.sprites.at(0)).toMatchObject({ x: 2, y: 3 });
  });

  test("a peer's sip or cheers shows on their disc", () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    const ada = room.peers.get('ada') as RemotePeer;
    ada.gesture = { kind: 'cheers', at: NOW - 1000 };
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    expect(world.sprites.at(0)).toMatchObject({ sip: 0, cheers: 1 });
    ada.gesture = { kind: 'sip', at: NOW - 1000 };
    world.collect(room.session, media, NOW, 0);
    expect(world.sprites.at(0)).toMatchObject({ sip: 1, cheers: 0, wobble: 0 });
  });

  test('a cheers under way stops showing once the peer holds the lighter', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    const ada = room.peers.get('ada') as RemotePeer;
    ada.gesture = { kind: 'cheers', at: NOW - 1000 };
    ada.info.held = 'lighter';
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    expect(world.sprites.at(0)).toMatchObject({ sip: 0, cheers: 0, wobble: 0 });
  });

  test('frames reuse the same disc and label objects', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    const [sprite, label] = [world.sprites.at(0), world.labels.at(0)];
    world.collect(room.session, media, NOW + 16, 0.016);
    expect(world.sprites.at(0)).toBe(sprite);
    expect(world.labels.at(0)).toBe(label);
  });

  test('a peer who left is gone from the discs and labels', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    room.addPeer('bob', 7, 1);
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    room.peers.delete('ada');
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    expect(world.sprites.map((s) => s.key)).toEqual(['bob']);
    expect(world.labels.map((l) => l.name)).toEqual(['bob']);
  });

  test('one voxel model per object, at its pose', () => {
    const world = createRemoteWorld();
    room.addObject('v1', 4, 5, 1);
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    expect(world.voxels).toHaveLength(1);
    expect(world.voxels.at(0)).toMatchObject({ x: 4, y: 5, angle: 1 });
  });

  test('the ball is drawn where the prediction says, not where its buffer is', () => {
    const world = createRemoteWorld();
    room.addObject('b1', 4, 5, 0, 'ball');
    world.sample(room.session, player, NOW, shown({ ...createBall('b1', 6, 7), heading: 2 }));
    world.collect(room.session, media, NOW, 0);
    expect(world.voxels.at(0)).toMatchObject({ model: BALL_MODEL, x: 6, y: 7, angle: 0 });
    expect(world.positions.get(objectKey('b1'))).toMatchObject({ x: 6, y: 7 });
  });

  test('the ball is drawn at its lift, the vacuum on the floor', () => {
    const world = createRemoteWorld();
    room.addObject('b1', 4, 5, 0, 'ball');
    room.addObject('v1', 2, 3, 0, 'vacuum');
    world.sample(room.session, player, NOW, shown(createBall('b1', 6, 7), 'asleep', 0.2));
    world.collect(room.session, media, NOW, 0);
    expect(world.voxels.find((v) => v.model === BALL_MODEL)?.lift).toBe(0.2);
    expect(world.voxels.find((v) => v.model !== BALL_MODEL)?.lift).toBe(0);
  });

  test("the ball's mood shakes where it is drawn, and sleeping draws it where it is", () => {
    const world = createRemoteWorld();
    room.addObject('b1', 4, 5, 0, 'ball');
    const ball = createBall('b1', 6, 7);
    const shaken = new Set<number>();
    for (let i = 0; i < 20; i++) {
      world.sample(room.session, player, NOW + i * 13, shown(ball, 'scared'));
      const y = world.objectPoses.get(objectKey('b1'))?.y ?? 0;
      shaken.add(y);
      expect(Math.abs(y - 7)).toBeLessThanOrEqual(0.03);
    }
    expect(shaken.size).toBeGreaterThan(1);
    world.sample(room.session, player, NOW, shown(ball));
    expect(world.objectPoses.get(objectKey('b1'))).toMatchObject({ x: 6, y: 7 });
    expect(ball).toMatchObject({ x: 6, y: 7 });
  });

  test('a vacuum and a ball get their own models', () => {
    const world = createRemoteWorld();
    room.addObject('v1', 4, 5, 1);
    room.addObject('b1', 2, 2, 0, 'ball');
    world.sample(room.session, player, NOW, shown(createBall('b1', 2, 2)));
    world.collect(room.session, media, NOW, 0);
    expect(world.voxels.map((v) => v.model)).toEqual([VACUUM_MODEL, BALL_MODEL]);
  });

  test('a ball with no prediction yet is not drawn', () => {
    const world = createRemoteWorld();
    room.addObject('b1', 2, 2, 0, 'ball');
    world.sample(room.session, player, NOW, null);
    world.collect(room.session, media, NOW, 0);
    expect(world.voxels).toHaveLength(0);
  });
});

describe('scooters', () => {
  /** A peer standing at (x, y) facing `angle`, riding scooter `scooter`. */
  const addRider = (id: string, x: number, y: number, angle: number, scooter: string) => {
    room.addPeer(id, x, y);
    const peer = room.peers.get(id);
    if (peer) {
      peer.info.riding = scooter;
      peer.buffer.push({ t: 1, x, y, angle });
    }
  };

  test('a parked scooter is drawn with its own model', () => {
    const world = createRemoteWorld();
    room.addObject('s1', 4, 5, 1, 'scooter');
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    expect(world.voxels.map((v) => v.model)).toEqual([SCOOTER_MODEL]);
  });

  test('a ridden scooter is drawn under its rider, the way they face, and the rider glides a deck higher', () => {
    const world = createRemoteWorld();
    addRider('ada', 2, 3, 1.5, 's1');
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0.1);
    expect(world.voxels).toHaveLength(1);
    expect(world.voxels.at(0)).toMatchObject({ model: RIDDEN_SCOOTER_MODEL, x: 2, y: 3, angle: 1.5, lift: 0 });
    expect(world.sprites.at(0)).toMatchObject({ bob: 0, itemBob: 0, ride: SCOOTER_DECK_TILES });
  });

  test('a rider who moved does not bob', () => {
    const world = createRemoteWorld();
    addRider('ada', 2, 3, 0, 's1');
    for (let i = 1; i <= 5; i++) {
      room.peers.get('ada')?.buffer.push({ t: NOW + i * 100, x: 2 + i * 0.3, y: 3, angle: 0 });
      world.sample(room.session, player, NOW + i * 100 + INTERP_DELAY_MS);
      world.collect(room.session, media, NOW, 0.1);
    }
    expect(world.sprites.at(0)?.bob).toBe(0);
  });

  test('someone on foot is on the floor', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    expect(world.sprites.at(0)?.ride).toBe(0);
    expect(world.voxels).toEqual([]);
  });

  test('frames reuse the same scooter voxels', () => {
    const world = createRemoteWorld();
    addRider('ada', 2, 3, 0, 's1');
    room.addObject('s2', 4, 5, 1, 'scooter');
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    const first = [...world.voxels];
    world.sample(room.session, player, NOW + 10);
    world.collect(room.session, media, NOW + 10, 0);
    expect(world.voxels.at(0)).toBe(first.at(0));
    expect(world.voxels.at(1)).toBe(first.at(1));
  });
});

describe('headlights', () => {
  test('a rider gets a headlight at their drawn position and heading; a walker gets none', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    room.addPeer('bob', 5, 3);
    const ada = room.peers.get('ada');
    if (!ada) {
      throw new Error('no ada');
    }
    ada.info.riding = 's1';
    ada.buffer = new SnapshotBuffer();
    ada.buffer.push({ t: 0, x: 2, y: 3, angle: 1.2 });
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    expect(world.headlights).toEqual([{ key: 'ada', x: 2, y: 3, angle: 1.2 }]);
    expect(world.voxels.map((v) => v.model)).toEqual([RIDDEN_SCOOTER_MODEL]);
    ada.info.riding = null;
    world.collect(room.session, media, NOW, 0);
    expect(world.headlights).toEqual([]);
  });

  test('a rider not yet drawn gets none', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    const ada = room.peers.get('ada');
    if (!ada) {
      throw new Error('no ada');
    }
    ada.info.riding = 's1';
    world.collect(room.session, media, NOW, 0);
    expect(world.headlights).toEqual([]);
  });
});

describe('items put away while riding', () => {
  test('a rider shows no drink, boombox or lighter, and stepping off brings them back', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    const peer = room.peers.get('ada');
    if (!peer) {
      throw new Error('no peer');
    }
    peer.info.held = 'lighter';
    peer.info.boombox = true;
    peer.info.riding = 's1';
    world.sample(room.session, player, NOW);
    world.collect(room.session, media, NOW, 0);
    expect(world.sprites.at(0)).toMatchObject({ held: null, boombox: false });
    expect(world.lighters).toEqual([]);
    peer.info.riding = null;
    world.collect(room.session, media, NOW, 0);
    expect(world.sprites.at(0)).toMatchObject({ held: 'lighter', boombox: true });
    expect(world.lighters).toHaveLength(1);
  });
});

describe('a ball someone else dribbles (ball dribble spec §4.2)', () => {
  test("it is drawn at the dribbler's hand from their drawn pose, not where the prediction has it", () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    room.addObject('b1', 9, 9, 0, 'ball');
    world.sample(room.session, player, NOW, shown(createBall('b1', 6, 7), 'asleep', 0.3, 'ada'));
    world.collect(room.session, media, NOW, 0);
    expect(world.voxels.find((v) => v.model === BALL_MODEL)).toMatchObject({ x: 3, y: 3, lift: 0.3 });
  });

  test('a holder who is not drawn (the local player) leaves it where the prediction has it', () => {
    const world = createRemoteWorld();
    room.addObject('b1', 9, 9, 0, 'ball');
    world.sample(room.session, player, NOW, shown(createBall('b1', 6, 7), 'asleep', 0, 'me'));
    world.collect(room.session, media, NOW, 0);
    expect(world.voxels.find((v) => v.model === BALL_MODEL)).toMatchObject({ x: 6, y: 7 });
  });

  test('the dribbler shows no item, and letting go brings it back', () => {
    const world = createRemoteWorld();
    room.addPeer('ada', 2, 3);
    room.addObject('b1', 9, 9, 0, 'ball');
    const peer = room.peers.get('ada');
    if (!peer) {
      throw new Error('no peer');
    }
    peer.info.held = 'lighter';
    world.sample(room.session, player, NOW, shown(createBall('b1', 6, 7), 'asleep', 0, 'ada'));
    world.collect(room.session, media, NOW, 0);
    expect(world.sprites.at(0)).toMatchObject({ held: null });
    expect(world.lighters).toEqual([]);
    world.sample(room.session, player, NOW, shown(createBall('b1', 6, 7)));
    world.collect(room.session, media, NOW, 0);
    expect(world.sprites.at(0)).toMatchObject({ held: 'lighter' });
  });
});
