import { expect, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

// Portal doorways spec §2.1: anyone flips the room's portals with Y, and everyone sees the notice.
type GameWindow = { __game: { portalsOn: boolean } };

const portalsOn = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as GameWindow).__game.portalsOn);

test('Y flips the room portals for everyone, at most once a second', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const roomUrl = await createAndJoin(a, 'Ada');
  await b.goto(roomUrl);
  await joinAs(b, 'Bob');
  expect(await portalsOn(a)).toBe(false);
  expect(await portalsOn(b)).toBe(false);

  await a.keyboard.press('y');
  await expect(b.locator('.portal-notice')).toHaveText('Portals on');
  await expect(a.locator('.portal-notice')).toHaveText('Portals on');
  await expect.poll(() => portalsOn(b)).toBe(true);
  await expect.poll(() => portalsOn(a)).toBe(true);

  // The server allows one flip per room per second.
  await a.waitForTimeout(1100);
  await a.keyboard.press('y');
  await expect(b.locator('.portal-notice')).toHaveText('Portals off');
  await expect(a.locator('.portal-notice')).toHaveText('Portals off');
  await expect.poll(() => portalsOn(b)).toBe(false);
  await expect.poll(() => portalsOn(a)).toBe(false);
});
