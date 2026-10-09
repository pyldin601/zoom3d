import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

const remoteSize = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('#media video');
    return v ? [v.videoWidth, v.videoHeight] : null;
  });
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

test('peers receive the framed 256² video; a hidden tab sends the raw frame until visible', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');
  await expect.poll(() => remoteSize(b), { timeout: 15_000 }).toEqual([256, 256]);
  await setHidden(a, true);
  await expect.poll(() => remoteSize(b), { timeout: 10_000 }).toEqual([640, 480]);
  await setHidden(a, false);
  await expect.poll(() => remoteSize(b), { timeout: 10_000 }).toEqual([256, 256]);
});

test('turning the camera off stops the camera', async ({ page }) => {
  await createAndJoin(page, 'Ada');
  // Keep the track itself: the framer drops it from its <video> when the camera stops.
  const held = () =>
    page.evaluate(() => {
      const w = window as unknown as { __cam?: MediaStreamTrack };
      w.__cam ??= (
        document.querySelector<HTMLVideoElement>('#local-media video')?.srcObject as MediaStream | null
      )?.getVideoTracks()[0];
      return w.__cam?.readyState ?? null;
    });
  await expect.poll(held).toBe('live');
  await page.getByRole('button', { name: 'Cam on' }).click();
  await expect.poll(held).toBe('ended');
});
