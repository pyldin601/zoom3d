import { expect, test } from '@playwright/test';
import { createAndJoin } from './join';

test('a name with movement letters can be typed on the join screen', async ({ page }) => {
  await page.goto('/r/AAAAAAAAAAAAAAAAAAAAAA');
  const field = page.getByPlaceholder('Your name');
  await field.click();
  await field.pressSequentially('Wade Sam Q');
  await expect(field).toHaveValue('Wade Sam Q');
});

test('a device menu works from the keyboard alone', async ({ page }) => {
  await page.goto('/r/AAAAAAAAAAAAAAAAAAAAAA');
  const opener = page.getByRole('button', { name: 'Choose microphone' });
  await expect(opener).toBeEnabled();
  await expect(opener).toHaveAttribute('aria-expanded', 'false');

  await opener.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Choose microphone' });
  await expect(menu).toBeVisible();
  await expect(opener).toHaveAttribute('aria-expanded', 'true');
  const items = menu.getByRole('menuitemradio');
  await expect(menu.getByRole('menuitemradio', { checked: true })).toBeFocused();

  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.first()).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(opener).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Your name' })).toBeFocused();
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
  await expect(page.locator('.console-panel .frame-rate')).toHaveText(/^Frame rate \d+ fps$/);
  await expect(page.locator('.console-panel .render-load')).toHaveText(/^Render time\d+% · \d+\.\d ms$/);
  await expect(page.getByText('Lighting')).toBeVisible();
  await page.keyboard.press('Backquote');
  await expect(page.locator('.console-panel')).toHaveCount(0);
});
