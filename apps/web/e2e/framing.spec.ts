import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs, lookAt } from './join';

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

test('peers receive a framed square face; a hidden tab sends the raw frame at that size until visible', async ({
  browser,
}) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');
  await lookAt(b, 'Ada');
  // Bob gets the 256, 128 or 64 face, depending on how big Ada is on his screen (6c).
  await expect.poll(async () => (await remoteSize(b))?.[0] ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  const [size, height] = (await remoteSize(b)) as [number, number];
  expect([64, 128, 256]).toContain(size);
  expect(height).toBe(size);
  // Hidden, Ada sends her raw 640×480 camera; the small faces scale it down to their size.
  await setHidden(a, true);
  const [rawW, rawH] = size === 256 ? [640, 480] : [(size * 4) / 3, size];
  const isRaw = (s: number[] | null) => s !== null && Math.abs((s[0] ?? 0) - rawW) <= 1 && s[1] === rawH;
  await expect.poll(async () => isRaw(await remoteSize(b)), { timeout: 10_000 }).toBe(true);
  await setHidden(a, false);
  await expect.poll(() => remoteSize(b), { timeout: 10_000 }).toEqual([size, size]);
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
