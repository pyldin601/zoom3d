import { expect, test } from '@playwright/test';
import { joinAs } from './join';

type GameWindow = {
  __game: {
    session: { peers: Map<string, { info: { name: string; x: number; y: number } }> } | null;
  };
};

const botPositions = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    [...((window as unknown as GameWindow).__game.session?.peers.values() ?? [])]
      .filter((p) => p.info.name.startsWith('Bot '))
      .map((p) => `${p.info.x.toFixed(2)},${p.info.y.toFixed(2)}`)
  );

test('a party started from /?bots=20 has 20 wandering bots; a normal party has none', async ({ page }) => {
  await page.goto('/?bots=20');
  await page.getByRole('button', { name: 'Start a party' }).click();
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}\?bots=20$/);
  await joinAs(page, 'Ada');
  await expect.poll(async () => (await botPositions(page)).length, { timeout: 10_000 }).toBe(20);
  const before = await botPositions(page);
  await expect.poll(async () => (await botPositions(page)).filter((p, i) => p !== before[i]).length).toBeGreaterThan(10);

  await page.goto('/');
  await page.getByRole('button', { name: 'Start a party' }).click();
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/);
  await joinAs(page, 'Bob');
  await page.waitForTimeout(500);
  expect(await botPositions(page)).toEqual([]);
});
