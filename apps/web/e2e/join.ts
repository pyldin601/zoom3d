import { expect, type Page } from '@playwright/test';

/** Opens a fresh room from the landing page and joins it; returns the room URL. */
export async function createAndJoin(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/);
  await joinAs(page, name);
  return page.url();
}

export async function joinAs(page: Page, name: string): Promise<void> {
  await page.getByPlaceholder('Your name').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __game: { session: { status(): string } | null } }).__game.session?.status(),
      ),
    )
    .toBe('open');
}
