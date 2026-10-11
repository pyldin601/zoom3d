import { expect, test } from '@playwright/test';
import { joinAs } from './join';

// Robot vacuum spec §3.1: every new party has one robot vacuum, and it moves.
type GameWindow = {
  __game: {
    session: { objects: Map<string, { info: { kind: string; x: number; y: number } }> } | null;
  };
};

const vacuums = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    [...((window as unknown as GameWindow).__game.session?.objects.values() ?? [])]
      .filter((o) => o.info.kind === 'vacuum')
      .map((o) => ({ x: o.info.x, y: o.info.y }))
  );

test('a new party has one robot vacuum that moves', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a party' }).click();
  await joinAs(page, 'Ada');
  await expect.poll(async () => (await vacuums(page)).length, { timeout: 10_000 }).toBe(1);
  const [start] = await vacuums(page);
  await expect
    .poll(
      async () => {
        const [now] = await vacuums(page);
        return now && start ? Math.hypot(now.x - start.x, now.y - start.y) : 0;
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0.3);
});
