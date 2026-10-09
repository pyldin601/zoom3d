import { expect, type Page, test } from '@playwright/test';
import { joinAs } from './join';

type GameWindow = {
  __game: {
    session: { peers: Map<string, { info: { name: string } }> } | null;
    call: { isLive(id: string): boolean; faceOf(id: string): Uint32Array | null } | null;
  };
};

/** Whether `name`'s face shows live video for this page, or null before the face exists. */
const isLive = (page: Page, name: string) =>
  page.evaluate((peerName) => {
    const g = (window as unknown as GameWindow).__game;
    const entry = [...(g.session?.peers.entries() ?? [])].find(([, p]) => p.info.name === peerName);
    if (!entry || !g.call?.faceOf(entry[0])) {
      return null;
    }
    return g.call.isLive(entry[0]);
  }, name);

async function openRoom(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page).toHaveURL(/\/r\//);
  return page.url();
}

/** Keeps the live camera track on window.__cam, once the framer has one. */
async function holdCamera(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stream = document.querySelector<HTMLVideoElement>('#local-media video')?.srcObject as MediaStream | null;
        const track = stream?.getVideoTracks()[0];
        (window as unknown as { __cam?: MediaStreamTrack }).__cam = track;
        return track?.readyState ?? null;
      })
    )
    .toBe('live');
}

const heldCameraState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cam?: MediaStreamTrack }).__cam?.readyState ?? null);

test('the lobby shows the camera preview and lists devices', async ({ page }) => {
  await openRoom(page);
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLVideoElement>('.lobby-disc video')?.readyState ?? 0))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Choose camera' }).click();
  await expect(page.getByRole('menuitemradio').first()).toBeVisible();
  await page.getByRole('menuitemradio').first().click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose microphone' }).click();
  await expect(page.getByRole('menuitemradio').first()).toBeVisible();
});

test('camera off in the lobby stops it; turning it on in the room sends live video', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const url = await openRoom(a);
  await holdCamera(a);
  await a.getByRole('button', { name: 'Turn camera off' }).click();
  await expect.poll(() => heldCameraState(a)).toBe('ended');
  await expect(a.getByRole('button', { name: 'Change picture' })).toBeVisible();
  await joinAs(a, 'Ada');

  const b = await (await browser.newContext()).newPage();
  await b.goto(url);
  await joinAs(b, 'Bob');
  await expect.poll(() => isLive(b, 'Ada'), { timeout: 15_000 }).toBe(false);

  await a.getByRole('button', { name: 'Cam off' }).click();
  await expect(a.getByRole('button', { name: 'Cam on' })).toBeVisible();
  await expect.poll(() => isLive(b, 'Ada'), { timeout: 15_000 }).toBe(true);
});

test('choosing a microphone really switches to it, and is restored after a reload', async ({ page }) => {
  // Records the label of every mic track getUserMedia hands out.
  await page.addInitScript(() => {
    const w = window as unknown as { __mics: string[] };
    w.__mics = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const stream = await original(c);
      w.__mics.push(...stream.getAudioTracks().map((t) => t.label));
      return stream;
    };
  });
  const lastMic = () => page.evaluate(() => (window as unknown as { __mics: string[] }).__mics.at(-1) ?? null);
  await openRoom(page);
  await expect.poll(lastMic).toBe('Fake Default Audio Input');
  await page.getByRole('button', { name: 'Choose microphone' }).click();
  await page.getByRole('menuitemradio', { name: 'Fake Audio Input 2' }).click();
  await expect.poll(lastMic).toBe('Fake Audio Input 2');
  await page.reload();
  await expect.poll(lastMic).toBe('Fake Audio Input 2');
});

test('closed menus stay out of sight', async ({ page }) => {
  await openRoom(page);
  await page.getByRole('button', { name: 'Turn camera off' }).click();
  await expect(page.getByRole('button', { name: 'Change picture' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose picture…' })).toBeHidden();
  await expect(page.locator('.device-menu').first()).toBeHidden();
  await page.getByRole('button', { name: 'Change picture' }).click();
  await expect(page.getByRole('button', { name: 'Choose picture…' })).toBeVisible();
});

test('the camera choice is remembered', async ({ page }) => {
  await openRoom(page);
  await holdCamera(page);
  await page.getByRole('button', { name: 'Turn camera off' }).click();
  await expect.poll(() => heldCameraState(page)).toBe('ended');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Turn camera on' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change picture' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join' })).toBeEnabled();
  expect(
    await page.evaluate(() => document.querySelector<HTMLVideoElement>('#local-media video')?.srcObject ?? null)
  ).toBeNull();
});
