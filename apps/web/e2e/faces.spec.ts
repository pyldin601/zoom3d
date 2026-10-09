import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

type GameWindow = {
  __game: {
    session: { peers: Map<string, { info: { name: string } }> } | null;
    call: {
      isLive(id: string): boolean;
      faceOf(id: string): Uint32Array | null;
      stats(id: string): Promise<{ bytesReceived: number } | null>;
    } | null;
  };
};

/** Face status of the peer with the given name, as seen from `page`. */
const faceOf = (page: Page, name: string) =>
  page.evaluate(async (peerName) => {
    const g = (window as unknown as GameWindow).__game;
    const entry = [...(g.session?.peers.entries() ?? [])].find(([, p]) => p.info.name === peerName);
    if (!entry || !g.call) return null;
    const [id] = entry;
    const stats = await g.call.stats(id);
    return { live: g.call.isLive(id), hasFace: g.call.faceOf(id) !== null, bytes: stats?.bytesReceived ?? 0 };
  }, name);

const remoteVideos = (page: Page) => page.locator('#media video').count();

test('faces stream both ways, cam off falls back to initials, leaving cleans up', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const bContext = await browser.newContext();
  const b = await bContext.newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');

  const liveAndFlowing = { live: true, hasFace: true, bytes: expect.any(Number) };
  await expect.poll(() => faceOf(a, 'Bob'), { timeout: 15_000 }).toEqual(liveAndFlowing);
  await expect.poll(() => faceOf(b, 'Ada'), { timeout: 15_000 }).toEqual(liveAndFlowing);
  expect((await faceOf(a, 'Bob'))?.bytes).toBeGreaterThan(0);
  expect((await faceOf(b, 'Ada'))?.bytes).toBeGreaterThan(0);

  await b.getByRole('button', { name: 'Cam on' }).click();
  await expect.poll(async () => (await faceOf(a, 'Bob'))?.live, { timeout: 3000 }).toBe(false);
  expect((await faceOf(a, 'Bob'))?.hasFace).toBe(true);

  // A third person whose camera is denied joins with initials.
  const c = await (await browser.newContext()).newPage();
  await c.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) =>
      constraints?.video ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : original(constraints);
  });
  await c.goto(url);
  await joinAs(c, 'Cy');
  await expect(c.getByText('Camera unavailable')).toBeVisible();
  await expect.poll(() => faceOf(a, 'Cy'), { timeout: 15_000 }).toMatchObject({ live: false, hasFace: true });

  await expect.poll(() => remoteVideos(a), { timeout: 15_000 }).toBe(2);
  await bContext.close();
  await expect.poll(() => remoteVideos(a), { timeout: 6000 }).toBe(1);
});
