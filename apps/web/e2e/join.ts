import { expect, type Page } from '@playwright/test';

/** Opens a fresh room from the landing page and joins it; returns the room URL. */
export async function createAndJoin(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a party' }).click();
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
        (window as unknown as { __game: { session: { status(): string } | null } }).__game.session?.status()
      )
    )
    .toBe('open');
}

/**
 * Turns `page`'s player to face the peer named `name`. Faces are only received from people in view (6c), and
 * players spawn facing a random direction.
 */
export async function lookAt(page: Page, name: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((peerName) => {
        type Peer = {
          info: { name: string };
          buffer: { sample(t: number, out: { x: number; y: number; angle: number }): boolean };
        };
        const g = (
          window as unknown as {
            __game: { player: { x: number; y: number; angle: number }; session: { peers: Map<string, Peer> } | null };
          }
        ).__game;
        const peer = [...(g.session?.peers.values() ?? [])].find((p) => p.info.name === peerName);
        const at = { x: 0, y: 0, angle: 0 };
        if (!peer?.buffer.sample(performance.now(), at)) {
          return false;
        }
        g.player.angle = Math.atan2(at.y - g.player.y, at.x - g.player.x);
        return true;
      }, name)
    )
    .toBe(true);
}
