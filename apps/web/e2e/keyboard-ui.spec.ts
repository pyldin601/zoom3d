import { expect, test } from '@playwright/test';

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
