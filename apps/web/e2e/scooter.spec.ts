import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

// Kick scooter spec: a rack along the entry corridor; E steps on and off, riding is twice walking speed, and the scooter stays
// where it was left. Everyone sees it.
type Scooter = { info: { id: string; kind: string; x: number; y: number } };
type GameWindow = {
  __game: {
    player: { x: number; y: number; angle: number };
    session: {
      riding: string | null;
      objects: Map<string, Scooter>;
      peers: Map<string, { info: { name: string; riding: string | null } }>;
    } | null;
  };
};

const parked = (page: Page) =>
  page.evaluate(() =>
    [...((window as unknown as GameWindow).__game.session?.objects.values() ?? [])]
      .filter((o) => o.info.kind === 'scooter')
      .map((o) => ({ x: o.info.x, y: o.info.y }))
  );
const riding = (page: Page) => page.evaluate(() => (window as unknown as GameWindow).__game.session?.riding ?? null);
const peerRiding = (page: Page, name: string) =>
  page.evaluate(
    (n) =>
      [...((window as unknown as GameWindow).__game.session?.peers.values() ?? [])].find((p) => p.info.name === n)?.info
        .riding ?? null,
    name
  );

/** Steps the player to (x, y) in 0.2-tile moves, slower than walking, so the server accepts each one. */
async function walkTo(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    async ({ tx, ty }) => {
      const p = (window as unknown as GameWindow).__game.player;
      for (;;) {
        const dx = tx - p.x;
        const dy = ty - p.y;
        const d = Math.hypot(dx, dy);
        if (d < 0.01) {
          return;
        }
        const s = Math.min(0.2, d);
        p.x += (dx / d) * s;
        p.y += (dy / d) * s;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    { tx: x, ty: y }
  );
}

test('a scooter is ridden from the rack, speeds up, rolls on, and is left where its rider steps off', async ({
  browser,
}) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');
  await expect.poll(() => parked(b)).toHaveLength(6);

  const rack = await parked(a);
  // The southernmost, the nearest to the spawn.
  const first = [...rack].sort((p, q) => q.y - p.y).at(0);
  if (!first) {
    throw new Error('no rack');
  }
  // The spawn is random near S, where a straight line to the corridor clips wall corners: out along S's row, then
  // north up the corridor's middle to stand beside the nearest scooter.
  const spawnX = await a.evaluate(() => (window as unknown as GameWindow).__game.player.x);
  await walkTo(a, spawnX, 50.5);
  await walkTo(a, 34.5, 50.5);
  await walkTo(a, 34.5, first.y);
  await walkTo(a, first.x + 0.8, first.y);
  await expect(a.locator('.ride-hint')).toBeVisible();
  await a.keyboard.press('e');
  await expect.poll(() => riding(a)).not.toBeNull();
  await expect.poll(() => peerRiding(b, 'Ada')).not.toBeNull();
  await expect.poll(() => parked(b)).toHaveLength(5);

  // North, up the corridor and into the hall.
  await a.evaluate(() => {
    (window as unknown as GameWindow).__game.player.angle = -Math.PI / 2;
  });
  const playerY = () => a.evaluate(() => (window as unknown as GameWindow).__game.player.y);
  const startY = await playerY();
  await a.keyboard.down('w');
  await a.waitForTimeout(1000);
  await a.keyboard.up('w');
  const throttledY = await playerY();
  // Electric: the motor takes 1.5 s to reach 6 tiles/s, so a second of throttle covers about 2 tiles, and walking 3.
  expect(startY - throttledY).toBeGreaterThan(1.5);
  expect(startY - throttledY).toBeLessThan(6);
  // Let go, it rolls on.
  await a.waitForTimeout(500);
  const coastedY = await playerY();
  expect(throttledY - coastedY).toBeGreaterThan(0.3);

  await a.keyboard.press('e');
  await expect.poll(() => riding(a)).toBeNull();
  await expect.poll(() => parked(b)).toHaveLength(6);
  const stopped = await a.evaluate(() => (window as unknown as GameWindow).__game.player);
  const left = (await parked(b)).find((s) => Math.hypot(s.x - stopped.x, s.y - stopped.y) < 0.5);
  expect(left).toBeDefined();
});
