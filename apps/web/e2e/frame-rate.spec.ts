import { type Browser, expect, type Page, test } from '@playwright/test';
import { RENDER_SETTINGS_KEY, type RenderSettings } from '../src/ui/render-settings';
import { createAndJoin, joinAs, lookAt } from './join';

// In a parallel run that oversubscribes the CPU, a frame that costs a third of the frame budget (the traced room's, in
// Chrome) can slip past its vsync and the interval snaps to 33 ms, and getting two people into a room took up to 30 s
// (the default timeout). A real regression fails every try. Only the traced test is given this slack.
const TRACED_TIMEOUT_MS = 60_000;
const TRACED_RETRIES = 2;
const BAKE_TIMEOUT_MS = 20_000;
const SETTLE_MS = 2000;

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

type TracedGame = { __game: { tracedReady: boolean } };

/**
 * Ada and Bob in one room, Bob's face playing at Ada's; returns the median frame interval at Ada's once the room is
 * drawn in the saved lighting. `savedLighting` is stored in Ada's browser before the page loads.
 */
async function medianFrameIntervalWithAPeer(browser: Browser, savedLighting: RenderSettings | null): Promise<number> {
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
  if (savedLighting?.mode === 'traced') {
    // Not the lit room drawn until the bake is done: the median would pass for either.
    await expect
      .poll(() => a.evaluate(() => (window as unknown as TracedGame).__game.tracedReady), { timeout: BAKE_TIMEOUT_MS })
      .toBe(true);
  }
  await a.waitForTimeout(SETTLE_MS);
  return medianFrameIntervalMs(a);
}

// A visible, playing remote <video> (even 1×1 at opacity 0.01) makes Chrome pace the page to the
// video's 30 fps. Measure the game's frame interval with a connected peer.
test('the game keeps ~60 fps while a peer is connected', async ({ browser }) => {
  expect(await medianFrameIntervalWithAPeer(browser, null)).toBeLessThan(20);
});

test.describe('ray traced', () => {
  test.describe.configure({ retries: TRACED_RETRIES });

  test('the ray traced room keeps ~60 fps while a peer is connected', async ({ browser }) => {
    test.setTimeout(TRACED_TIMEOUT_MS);
    expect(await medianFrameIntervalWithAPeer(browser, { mode: 'traced' })).toBeLessThan(20);
  });
});
