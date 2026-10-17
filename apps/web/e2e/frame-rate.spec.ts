import { type Browser, expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs, lookAt } from './join';

const RENDER_SETTINGS_KEY = 'zoom3d.render.v1';
/** The traced room is baked over about 2 s of frames after joining: its frames are timed once that is done. */
const LIGHTING_SETTLE_MS = 2000;
// In a parallel run that oversubscribes the CPU, a frame that costs a third of the frame budget (the traced room's, in
// Chrome) can slip past its vsync and the interval snaps to 33 ms, and getting two people into a room took up to 30 s
// (the default timeout). A real regression fails every try.
const SLOW_SUITE_TIMEOUT_MS = 60_000;
const SLOW_SUITE_RETRIES = 2;
test.describe.configure({ retries: SLOW_SUITE_RETRIES });

async function medianFrameIntervalMs(page: Page): Promise<number> {
  return page.evaluate(
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
            resolve([...deltas].sort((x, y) => x - y).at(60) ?? Number.POSITIVE_INFINITY);
          }
        };
        requestAnimationFrame(step);
      })
  );
}

/**
 * Ada and Bob in one room, Bob's face playing at Ada's; returns the median frame interval at Ada's once the lighting
 * has had time to settle. `savedLighting` is stored in Ada's browser before the page loads.
 */
async function medianFrameIntervalWithAPeer(browser: Browser, savedLighting: { mode: string } | null): Promise<number> {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  if (savedLighting) {
    await a.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: RENDER_SETTINGS_KEY,
      value: JSON.stringify(savedLighting),
    });
  }
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
  await a.waitForTimeout(LIGHTING_SETTLE_MS);
  return medianFrameIntervalMs(a);
}

// A visible, playing remote <video> (even 1×1 at opacity 0.01) makes Chrome pace the page to the
// video's 30 fps. Measure the game's frame interval with a connected peer.
test('the game keeps ~60 fps while a peer is connected', async ({ browser }) => {
  test.setTimeout(SLOW_SUITE_TIMEOUT_MS);
  expect(await medianFrameIntervalWithAPeer(browser, null)).toBeLessThan(20);
});

test('the ray traced room keeps ~60 fps while a peer is connected', async ({ browser }) => {
  test.setTimeout(SLOW_SUITE_TIMEOUT_MS);
  expect(await medianFrameIntervalWithAPeer(browser, { mode: 'traced' })).toBeLessThan(20);
});
