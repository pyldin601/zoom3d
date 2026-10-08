import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

type GameWindow = {
  __game: {
    session: { peers: Map<string, { info: { name: string } }> } | null;
    audio: { inputLevel(id: string): number; speaking(id: string): number } | null;
  };
};

/** Highest input level / speaking value seen for `name` over `ms`, sampled every 50 ms. */
const peakAudio = (page: Page, name: string, ms: number) =>
  page.evaluate(
    async ([peerName, duration]) => {
      const g = (window as unknown as GameWindow).__game;
      let input = 0;
      let speaking = 0;
      const end = performance.now() + (duration as number);
      while (performance.now() < end) {
        const entry = [...(g.session?.peers.entries() ?? [])].find(([, p]) => p.info.name === peerName);
        if (entry && g.audio) {
          input = Math.max(input, g.audio.inputLevel(entry[0]));
          speaking = Math.max(speaking, g.audio.speaking(entry[0]));
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { input, speaking };
    },
    [name, ms] as const,
  );

test('voices flow into the spatial engine and remote elements stay muted', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');

  // Chrome's fake microphone beeps; within a few seconds Bob's voice must reach A's engine.
  await expect
    .poll(async () => (await peakAudio(a, 'Bob', 1500)).input, { timeout: 20_000 })
    .toBeGreaterThan(0.005);
  await expect
    .poll(async () => (await peakAudio(a, 'Bob', 1500)).speaking, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const videos = a.locator('#media video');
  await expect(videos).toHaveCount(1);
  expect(await videos.evaluateAll((els) => els.every((el) => (el as HTMLVideoElement).muted))).toBe(true);
});

test('the backquote key toggles the audio tuning panel in a room', async ({ page }) => {
  await createAndJoin(page, 'Ada');
  await page.locator('#stage').click();
  await page.keyboard.press('Backquote');
  await expect(page.getByText('Silent beyond')).toBeVisible();
  await page.keyboard.press('Backquote');
  await expect(page.getByText('Silent beyond')).toHaveCount(0);
});
