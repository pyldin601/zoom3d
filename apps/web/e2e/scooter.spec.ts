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

test('a scooter is ridden from the rack, speeds up, rolls on, and is left where its rider steps off', async ({
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
  // The spawn is random near S, where a straight line to the rack can clip a wall corner: reach the rack's row first.
  const spawnX = await a.evaluate(() => (window as unknown as GameWindow).__game.player.x);
  await walkTo(a, spawnX, first.y);
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
  const playerX = () => a.evaluate(() => (window as unknown as GameWindow).__game.player.x);
  const startX = await playerX();
  await a.keyboard.down('w');
  await a.waitForTimeout(1000);
  await a.keyboard.up('w');
  const throttledX = await playerX();
  // Electric: the motor takes 1.5 s to reach 6 tiles/s, so a second of throttle covers about 2 tiles, and walking 3.
  expect(startX - throttledX).toBeGreaterThan(1.5);
  expect(startX - throttledX).toBeLessThan(6);
  // Let go, it rolls on.
  await a.waitForTimeout(500);
  const coastedX = await playerX();
  expect(throttledX - coastedX).toBeGreaterThan(0.3);

  await a.keyboard.press('e');
  await expect.poll(() => riding(a)).toBeNull();
  await expect.poll(() => parked(b)).toHaveLength(4);
  const stoppedX = await playerX();
  const left = (await parked(b)).find((s) => Math.abs(s.x - stoppedX) < 0.5);
  expect(left).toBeDefined();
});
