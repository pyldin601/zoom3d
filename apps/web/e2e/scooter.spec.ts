import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

// Kick scooter spec: a rack by the spawn; E steps on and off, riding is twice walking speed, and the scooter stays
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

test('a scooter is ridden from the rack at twice walking pace and left where its rider steps off', async ({
  browser,
}) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');
  await expect.poll(() => parked(b)).toHaveLength(4);

  const rack = await parked(a);
  const first = rack.at(0);
  if (!first) {
    throw new Error('no rack');
  }
  await walkTo(a, first.x - 0.7, first.y);
  await expect(a.locator('.ride-hint')).toBeVisible();
  await a.keyboard.press('e');
  await expect.poll(() => riding(a)).not.toBeNull();
  await expect.poll(() => peerRiding(b, 'Ada')).not.toBeNull();
  await expect.poll(() => parked(b)).toHaveLength(3);

  // West, down the open hall.
  await a.evaluate(() => {
    (window as unknown as GameWindow).__game.player.angle = Math.PI;
  });
  const startX = await a.evaluate(() => (window as unknown as GameWindow).__game.player.x);
  await a.keyboard.down('w');
  await a.waitForTimeout(1000);
  await a.keyboard.up('w');
  const endX = await a.evaluate(() => (window as unknown as GameWindow).__game.player.x);
  expect(startX - endX).toBeGreaterThan(4.5);
  // Not corrected back: the server accepted the ride.
  await a.waitForTimeout(500);
  const settledX = await a.evaluate(() => (window as unknown as GameWindow).__game.player.x);
  expect(settledX).toBeCloseTo(endX, 1);

  await a.keyboard.press('e');
  await expect.poll(() => riding(a)).toBeNull();
  await expect.poll(() => parked(b)).toHaveLength(4);
  const left = (await parked(b)).find((s) => Math.abs(s.x - settledX) < 0.3);
  expect(left).toBeDefined();
});
