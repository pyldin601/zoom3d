import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

// Portal sequence spec §2.1: anyone switches the room's portals with Y, and everyone goes through the same sequence.
// The first switch-on counts down for 3 s, goes dark, bends at 5 s and brings the lamps back at 7 s; every later
// switch is 1 s of dark, bending at 0.5 s.
type GameWindow = { __game: { portalsOn: boolean; sequenceDark(): boolean } };

const portalsOn = (page: Page) => page.evaluate(() => (window as unknown as GameWindow).__game.portalsOn);
const dark = (page: Page) => page.evaluate(() => (window as unknown as GameWindow).__game.sequenceDark());

test('Y runs the room portal sequence for everyone: the countdown, the dark, then the portals', async ({ browser }) => {
  test.setTimeout(60_000);
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  const roomUrl = await createAndJoin(a, 'Ada');
  await b.goto(roomUrl);
  await joinAs(b, 'Bob');
  expect(await portalsOn(a)).toBe(false);
  expect(await portalsOn(b)).toBe(false);

  await a.keyboard.press('y');
  const pressedAt = Date.now();
  await expect(b.locator('.portal-countdown')).toHaveText('Portals will enable in 3…', { timeout: 1000 });
  await expect(b.locator('.portal-countdown')).toHaveText('Portals will enable in 1…', { timeout: 3000 });
  expect(await dark(b)).toBe(false);

  await b.waitForTimeout(3500 - (Date.now() - pressedAt));
  expect(await dark(b)).toBe(true);
  await expect(b.locator('.portal-countdown')).toHaveCount(0);
  expect(await portalsOn(b)).toBe(false);

  await b.waitForTimeout(5500 - (Date.now() - pressedAt));
  expect(await portalsOn(b)).toBe(true);
  expect(await portalsOn(a)).toBe(true);
  expect(await dark(b)).toBe(true);
  await expect(b.locator('.portal-notice')).toHaveText('Portals on');

  await expect.poll(() => dark(b), { timeout: 3000 }).toBe(false);
  await expect.poll(() => dark(a)).toBe(false);

  // A later switch has no countdown: 1 s of dark, and the space unbends halfway.
  await a.keyboard.press('y');
  await expect.poll(() => dark(b), { timeout: 1000, intervals: [50] }).toBe(true);
  await expect(b.locator('.portal-countdown')).toHaveCount(0);
  await expect(b.locator('.portal-notice')).toHaveText('Portals off');
  await expect.poll(() => portalsOn(b)).toBe(false);
  await expect.poll(() => portalsOn(a)).toBe(false);
  await expect.poll(() => dark(b)).toBe(false);
  await aContext.close();
  await bContext.close();
});
