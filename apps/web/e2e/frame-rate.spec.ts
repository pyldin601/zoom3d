import { expect, test } from '@playwright/test';
import { createAndJoin, joinAs, lookAt } from './join';

// A visible, playing remote <video> (even 1×1 at opacity 0.01) makes Chrome pace the page to the
// video's 30 fps. Measure the game's frame interval with a connected peer.
test('the game keeps ~60 fps while a peer is connected', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');
  // Bob's face must be playing at Ada's: faces are only received from people in view.
  await lookAt(a, 'Bob');
  await expect
    .poll(() => a.evaluate(() => document.querySelector<HTMLVideoElement>('#media video')?.videoWidth ?? 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  await a.bringToFront();
  await a.waitForTimeout(2000);
  const median = await a.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const deltas: number[] = [];
        let last = 0;
        const step = (t: number) => {
          if (last) {
            deltas.push(t - last);
          }
          last = t;
          if (deltas.length < 120) {
            requestAnimationFrame(step);
          } else {
            resolve([...deltas].sort((x, y) => x - y)[60] as number);
          }
        };
        requestAnimationFrame(step);
      })
  );
  expect(median).toBeLessThan(20);
});
