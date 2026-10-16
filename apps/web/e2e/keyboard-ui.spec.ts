import { expect, test } from '@playwright/test';
import { createAndJoin } from './join';

test('a name with movement letters can be typed on the join screen', async ({ page }) => {
  await page.goto('/r/AAAAAAAAAAAAAAAAAAAAAA');
  const field = page.getByPlaceholder('Your name');
  await field.click();
  await field.pressSequentially('Wade Sam Q');
  await expect(field).toHaveValue('Wade Sam Q');
});

test('Tab moves focus on the landing page', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Start a party' })).toBeFocused();
});

test('in a room, M mutes and unmutes the mic and C turns the camera off and on', async ({ page }) => {
  await createAndJoin(page, 'Ada');
  const mic = page.locator('button[data-control="mic"]');
  const cam = page.locator('button[data-control="cam"]');
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await expect(cam).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('KeyM');
  await expect(mic).toHaveAttribute('aria-label', 'Mic off');
  await page.keyboard.press('KeyM');
  await expect(mic).toHaveAttribute('aria-label', 'Mic on');
  await page.keyboard.press('KeyC');
  await expect(cam).toHaveAttribute('aria-label', 'Cam off');
  await page.keyboard.press('KeyC');
  await expect(cam).toHaveAttribute('aria-label', 'Cam on');
  // A shortcut is left to the browser.
  await page.keyboard.press('ControlOrMeta+KeyC');
  await expect(cam).toHaveAttribute('aria-label', 'Cam on');
});

test('in a room, the backquote key toggles the frame rate and renderer panel', async ({ page }) => {
  await createAndJoin(page, 'Ada');
  await page.locator('#stage').click();
  await page.keyboard.press('Backquote');
  await expect(page.locator('.audio-panel .frame-rate')).toHaveText(/^Frame rate \d+ fps$/);
  await expect(page.locator('.audio-panel .render-load')).toHaveText(/^Render time\d+% · \d+\.\d ms$/);
  await expect(page.getByText('Lighting')).toBeVisible();
  await page.keyboard.press('Backquote');
  await expect(page.locator('.audio-panel')).toHaveCount(0);
});
