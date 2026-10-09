import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

type GameWindow = {
  __game: {
    map: { width: number; tiles: Uint8Array };
    player: { x: number; y: number; angle: number };
    session: {
      peers: Map<string, { info: { name: string }; buffer: { latest(): { x: number; y: number } | null } }>;
    } | null;
  };
};

const peerNames = (page: Page) =>
  page.evaluate(() =>
    [...((window as unknown as GameWindow).__game.session?.peers.values() ?? [])].map((p) => p.info.name)
  );

test('two people see each other, movement syncs, and leaving is noticed', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const bContext = await browser.newContext();
  const b = await bContext.newPage();

  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');

  await expect.poll(() => peerNames(a), { timeout: 5000 }).toEqual(['Bob']);
  await expect.poll(() => peerNames(b), { timeout: 5000 }).toEqual(['Ada']);

  // Step Bob 0.4 tiles onto a free tile (inside the server's per-update slack).
  const target = await b.evaluate(() => {
    const g = (window as unknown as GameWindow).__game;
    const free = (x: number, y: number) => g.map.tiles[Math.floor(y) * g.map.width + Math.floor(x)] === 0;
    for (const [dx, dy] of [
      [0.4, 0],
      [-0.4, 0],
      [0, 0.4],
      [0, -0.4],
    ] as const) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      if (free(x + Math.sign(dx) * 0.25, y + Math.sign(dy) * 0.25)) {
        g.player.x = x;
        g.player.y = y;
        return { x, y };
      }
    }
    throw new Error('no free direction');
  });

  await expect
    .poll(
      () =>
        a.evaluate(() => {
          const [bob] = (window as unknown as GameWindow).__game.session?.peers.values() ?? [];
          return bob?.buffer.latest() ?? null;
        }),
      { timeout: 2000 }
    )
    .toEqual(expect.objectContaining({ x: expect.closeTo(target.x, 1), y: expect.closeTo(target.y, 1) }));

  await bContext.close();
  await expect.poll(() => peerNames(a), { timeout: 4000 }).toEqual([]);
});

test('a malformed room link shows a notice', async ({ page }) => {
  await page.goto('/r/short');
  await expect(page.getByText('Bad room link')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start a new room' })).toHaveAttribute('href', '/');
});
