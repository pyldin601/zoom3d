import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs, lookAt } from './join';

type GameWindow = {
  __game: {
    map: { width: number; tiles: Uint8Array };
    player: { x: number; y: number; angle: number };
    session: {
      selfId(): string | null;
      peers: Map<string, { info: { id: string; name: string; x: number; y: number } }>;
    } | null;
    call: { isLive(id: string): boolean; stats(id: string): Promise<{ bytesReceived: number } | null> } | null;
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

/** Whether `page` shows `id`'s live face, and how many bytes of it have arrived. */
const faceFrom = (page: Page, id: string) =>
  page.evaluate(async (peerId) => {
    const call = (window as unknown as GameWindow).__game.call;
    return { live: call?.isLive(peerId) ?? false, bytes: (await call?.stats(peerId))?.bytesReceived ?? 0 };
  }, id);
const voiceOf = (page: Page, id: string) => page.locator(`#media audio[data-peer="voice:${id}"]`);

test('after a reload the others get the face and voice again, and the reloaded tab gets theirs', async ({
  browser,
}) => {
  const ada = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  const url = await createAndJoin(ada, 'Ada');
  await bob.goto(url);
  await joinAs(bob, 'Bob');
  const adaId = (await selfId(ada)) as string;
  const bobId = (await selfId(bob)) as string;
  await lookAt(ada, 'Bob');
  await expect.poll(async () => (await faceFrom(ada, bobId)).live, { timeout: 15_000 }).toBe(true);
  await expect(voiceOf(ada, bobId)).toHaveCount(1);

  await bob.reload();
  await joinAs(bob, 'Bob');
  expect(await selfId(bob)).toBe(bobId);

  const before = (await faceFrom(ada, bobId)).bytes;
  await expect
    .poll(async () => (await faceFrom(ada, bobId)).bytes - before, { timeout: 15_000 })
    .toBeGreaterThan(20_000);
  expect((await faceFrom(ada, bobId)).live).toBe(true);
  await expect(voiceOf(ada, bobId)).toHaveCount(1);
  await lookAt(bob, 'Ada');
  await expect.poll(async () => (await faceFrom(bob, adaId)).live, { timeout: 15_000 }).toBe(true);
  await expect(voiceOf(bob, adaId)).toHaveCount(1);
});

test('a reload that changes the name in the lobby joins as someone new, and the old place leaves', async ({
  browser,
}) => {
  const ada = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  const url = await createAndJoin(ada, 'Ada');
  await bob.goto(url);
  await joinAs(bob, 'Bob');
  const bobId = await selfId(bob);

  await bob.reload();
  await joinAs(bob, 'Robert');

  expect(await selfId(bob)).not.toBe(bobId);
  await expect.poll(async () => (await peers(ada)).map((p) => p.name)).toEqual(['Robert']);
  await expect(ada.getByTitle('2 people in the room')).toHaveText('2');
});
