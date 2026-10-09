import { expect, test } from '@playwright/test';
import { createAndJoin } from './join';

test('clicking the stage in a room engages pointer lock on the game canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await createAndJoin(page, 'Ada');
  const box = await page.locator('#stage').boundingBox();
  if (!box) {
    throw new Error('#stage has no box');
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id ?? null)).toBe('game');
});
