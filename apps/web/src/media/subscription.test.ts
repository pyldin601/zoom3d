import { FOV_WIDE, type Point, parseMap } from '@zoom3d/shared';
import { expect, test, vi } from 'vitest';
import { INTEREST_MS } from './interest';
import { createSubscription, type Surroundings } from './subscription';

const MAP = parseMap(['1111111111', '1........1', '1.S......1', '1........1', '1111111111'].join('\n'));

function around(positions: Record<string, Point>, over: Partial<Surroundings> = {}): Surroundings {
  return {
    call: { publishes: (id) => id !== 'bot', setWanted: vi.fn() },
    people: new Map(Object.keys(positions).map((id) => [id, {}])),
    positions: new Map(Object.entries(positions)),
    player: { x: 2.5, y: 2.5, angle: 0 },
    fov: FOV_WIDE,
    map: MAP,
    maxDistance: 24,
    hidden: false,
    ...over,
  };
}

test('sends each want once, and again only when it changes', () => {
  const sub = createSubscription();
  const world = around({ ada: { x: 5.5, y: 2.5 } });
  sub.choose(0, world);
  expect(world.call.setWanted).toHaveBeenCalledTimes(1);
  sub.choose(INTEREST_MS, world);
  expect(world.call.setWanted).toHaveBeenCalledTimes(1);
  sub.choose(INTEREST_MS * 2, { ...world, hidden: true });
  expect(world.call.setWanted).toHaveBeenLastCalledWith('ada', expect.objectContaining({ video: 'off' }));
});

test('chooses at most every INTEREST_MS', () => {
  const sub = createSubscription();
  const first = around({ ada: { x: 5.5, y: 2.5 } });
  sub.choose(0, first);
  const soon = around({ ada: { x: 5.5, y: 2.5 } });
  sub.choose(INTEREST_MS - 1, soon);
  expect(soon.call.setWanted).not.toHaveBeenCalled();
});

test('bots and world objects are never asked for media', () => {
  const sub = createSubscription();
  const world = around({ bot: { x: 4.5, y: 2.5 } });
  (world.positions as Map<string, Point>).set('object:v1', { x: 6.5, y: 2.5 });
  sub.choose(0, world);
  expect(world.call.setWanted).not.toHaveBeenCalled();
});

test('what the frame saw of someone who left is forgotten', () => {
  const sub = createSubscription();
  sub.seen.set('gone', { drawnColumns: 3, projectedSize: 40 });
  sub.choose(0, around({ ada: { x: 5.5, y: 2.5 } }));
  expect(sub.seen.has('gone')).toBe(false);
});

test('a new call gets every want again', () => {
  const sub = createSubscription();
  sub.choose(0, around({ ada: { x: 5.5, y: 2.5 } }));
  const next = around({ ada: { x: 5.5, y: 2.5 } });
  sub.choose(INTEREST_MS, next);
  expect(next.call.setWanted).toHaveBeenCalledTimes(1);
});
