import { expect, type Page, test } from '@playwright/test';

// Landing vacuum spec: the title picture comes alive 10 s after it shows, ignores input, and resets on Start a party.
// Checks stay well clear of the 10 s mark: show time never runs ahead of the clock, but a loaded machine runs behind.
test.setTimeout(60_000);

/** The game canvas's pixels (not a page screenshot, so hover states on the panel above it don't count). */
const frame = (page: Page) => page.evaluate(() => (document.getElementById('game') as HTMLCanvasElement).toDataURL());

test('the vacuum comes out after 10 seconds', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1_000);
  const early = await frame(page);
  await page.waitForTimeout(5_000);
  const parked = await frame(page);
  expect(parked).toBe(early);
  // It is in view for a few seconds from about 13 s, then cleans out of sight: poll rather than sample one moment.
  await expect.poll(() => frame(page), { timeout: 30_000 }).not.toBe(parked);
});

test('input does not wake the vacuum early', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1_000);
  const early = await frame(page);
  const box = await page.locator('#game').boundingBox();
  if (!box) {
    throw new Error('no game canvas');
  }
  await page.mouse.click(box.x + 40, box.y + 40);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3, { steps: 10 });
  for (const key of ['w', 'ArrowLeft', 'Space']) {
    await page.keyboard.press(key);
  }
  await page.waitForTimeout(4_000);
  expect(await frame(page)).toBe(early);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
});

test('Start a party resets to a still lobby picture', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(14_000);
  await page.getByRole('button', { name: 'Start a party' }).click();
  await page.waitForTimeout(500);
  const lobby = await frame(page);
  await page.waitForTimeout(2_000);
  expect(await frame(page)).toBe(lobby);
});

test('reduced motion keeps the still picture', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.waitForTimeout(1_000);
  const early = await frame(page);
  await page.waitForTimeout(13_000);
  expect(await frame(page)).toBe(early);
});
