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
    [name, ms] as const
  );

test('voices flow into the spatial engine and remote elements stay muted', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');

  // Chrome's fake microphone beeps; within a few seconds Bob's voice must reach A's engine.
  await expect.poll(async () => (await peakAudio(a, 'Bob', 1500)).input, { timeout: 20_000 }).toBeGreaterThan(0.005);
  await expect.poll(async () => (await peakAudio(a, 'Bob', 1500)).speaking, { timeout: 10_000 }).toBeGreaterThan(0);

  // Bob's voice plays from its own element (separate from his face), muted like every remote element.
  await expect(a.locator('#media audio[data-peer^="voice:"]')).toHaveCount(1);
  const elements = a.locator('#media video, #media audio');
  expect(await elements.evaluateAll((els) => els.every((el) => (el as HTMLMediaElement).muted))).toBe(true);
});
