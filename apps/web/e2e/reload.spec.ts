import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

type GameWindow = {
  __game: {
    map: { width: number; tiles: Uint8Array };
    player: { x: number; y: number; angle: number };
    session: {
      selfId(): string | null;
      peers: Map<string, { info: { id: string; name: string; x: number; y: number } }>;
    } | null;
  };
};

const selfId = (page: Page) => page.evaluate(() => (window as unknown as GameWindow).__game.session?.selfId());
const pose = (page: Page) => page.evaluate(() => ({ ...(window as unknown as GameWindow).__game.player }));
const peers = (page: Page) =>
  page.evaluate(() =>
    [...((window as unknown as GameWindow).__game.session?.peers.values() ?? [])].map((p) => ({ ...p.info }))
  );

/** Steps 0.4 tiles onto a free tile (inside the server's per-update slack) and turns, so the spot is not the spawn. */
const stepAside = (page: Page) =>
  page.evaluate(() => {
    const g = (window as unknown as GameWindow).__game;
    const free = (x: number, y: number) => g.map.tiles[Math.floor(y) * g.map.width + Math.floor(x)] === 0;
    for (const [dx, dy] of [
      [0.4, 0],
      [-0.4, 0],
      [0, 0.4],
      [0, -0.4],
    ] as const) {
      if (free(g.player.x + dx + Math.sign(dx) * 0.25, g.player.y + dy + Math.sign(dy) * 0.25)) {
        g.player.x += dx;
        g.player.y += dy;
        g.player.angle = 1.25;
        return { x: g.player.x, y: g.player.y };
      }
    }
    throw new Error('no free direction');
  });

test('a reloaded tab joins back into its own place', async ({ browser }) => {
  const ada = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  const url = await createAndJoin(ada, 'Ada');
  await bob.goto(url);
  await joinAs(bob, 'Bob');

  const bobId = await selfId(bob);
  const spot = await stepAside(bob);
  await expect.poll(async () => (await peers(ada)).map((p) => [p.x, p.y])).toEqual([[spot.x, spot.y]]);

  await bob.reload();
  await joinAs(bob, 'Bob');

  expect(await selfId(bob)).toBe(bobId);
  expect(await pose(bob)).toMatchObject({ x: spot.x, y: spot.y, angle: 1.25 });
  expect((await peers(ada)).map((p) => p.id)).toEqual([bobId]);
  await expect(ada.getByTitle('2 people in the room')).toHaveText('2');
});

test('a new tab in the same browser joins as someone new', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const url = await createAndJoin(first, 'Ada');
  const second = await context.newPage();
  await second.goto(url);
  await joinAs(second, 'Ada');

  expect(await selfId(second)).not.toBe(await selfId(first));
  await expect(first.getByTitle('2 people in the room')).toHaveText('2');
});
