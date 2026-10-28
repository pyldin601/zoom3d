import {
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
import { VACUUM_MODEL } from '../renderer/models/vacuum';
import { hexToRgb } from '../renderer/sprites';
import { createRemoteWorld, type PeerMedia } from './remote-world';

const NOW = 10_000;
const player = { x: 0, y: 0 };
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
    expect(world.positions.get(objectKey('v1'))).toEqual({ x: 4, y: 5, angle: 1 });
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

describe('collect', () => {
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
    world.sample(room.session, player, NOW, { ...createBall('b1', 6, 7), heading: 2 });
    world.collect(room.session, media, NOW, 0);
    expect(world.voxels.at(0)).toMatchObject({ model: BALL_MODEL, x: 6, y: 7, angle: 0 });
    expect(world.positions.get(objectKey('b1'))).toMatchObject({ x: 6, y: 7 });
  });

  test('a vacuum and a ball get their own models', () => {
    const world = createRemoteWorld();
    room.addObject('v1', 4, 5, 1);
    room.addObject('b1', 2, 2, 0, 'ball');
    world.sample(room.session, player, NOW, createBall('b1', 2, 2));
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
