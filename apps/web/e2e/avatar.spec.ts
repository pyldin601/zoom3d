import { expect, type Page, test } from '@playwright/test';
import { joinAs } from './join';

type GameWindow = {
  __game: {
    session: { peers: Map<string, { info: { name: string } }> } | null;
    call: { isLive(id: string): boolean; faceOf(id: string): Uint32Array | null } | null;
  };
};

/** Centre texel of a peer's face as [r, g, b] plus whether it shows live video. */
const faceCentre = (page: Page, name: string) =>
  page.evaluate((peerName) => {
    const g = (window as unknown as GameWindow).__game;
    const entry = [...(g.session?.peers.entries() ?? [])].find(([, p]) => p.info.name === peerName);
    const texels = entry && g.call?.faceOf(entry[0]);
    if (!entry || !texels || !g.call) {
      return null;
    }
    const size = Math.sqrt(texels.length);
    // ImageData texels viewed as Uint32 on little-endian: 0xAABBGGRR.
    const v = texels[(size / 2) * size + size / 2] ?? 0;
    return { live: g.call.isLive(entry[0]), rgb: [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff] };
  }, name);

/** A solid blue PNG, made by the browser itself. */
const bluePng = async (page: Page) =>
  Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 300;
      c.height = 200;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(0, 0, 300, 200);
      return c.toDataURL('image/png').split(',')[1] as string;
    }),
    'base64'
  );

const isBlue = (rgb: number[] | undefined) =>
  rgb !== undefined && (rgb[2] ?? 0) > 200 && (rgb[0] ?? 255) < 60 && (rgb[1] ?? 255) < 60;

test('a picked picture replaces initials while the camera is off, and is remembered', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  await a.goto('/');
  await a.getByRole('button', { name: 'Start a party' }).click();
  await expect(a).toHaveURL(/\/r\//);
  const url = a.url();

  // The picture shows (and can be changed) only while the camera is off.
  await a.getByRole('button', { name: 'Turn camera off' }).click();
  await a.locator('input[type="file"]').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: await bluePng(a),
  });
  await expect(a.locator('.avatar img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await a.getByRole('button', { name: 'Turn camera on' }).click();
  await expect(a.locator('.avatar img')).toHaveCount(0);
  await joinAs(a, 'Ada');

  const b = await (await browser.newContext()).newPage();
  await b.goto(url);
  await joinAs(b, 'Bob');
  await expect.poll(async () => (await faceCentre(b, 'Ada'))?.live, { timeout: 15_000 }).toBe(true);

  await a.getByRole('button', { name: 'Cam on' }).click();
  // Ada's own circle shows her picture too.
  await expect(a.locator('.selfview .face img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect.poll(async () => (await faceCentre(b, 'Ada'))?.live, { timeout: 3000 }).toBe(false);
  await expect.poll(async () => isBlue((await faceCentre(b, 'Ada'))?.rgb), { timeout: 3000 }).toBe(true);

  // Bob has no picture: Ada sees his initials disc in his colour, not blue.
  await expect.poll(() => faceCentre(a, 'Bob'), { timeout: 15_000 }).not.toBeNull();
  expect(isBlue((await faceCentre(a, 'Bob'))?.rgb)).toBe(false);

  // Ada turned her camera off in the room, and the lobby remembers it.
  await a.reload();
  await expect(a.getByRole('button', { name: 'Turn camera on' })).toBeVisible();
  await expect(a.locator('.avatar img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await a.getByRole('button', { name: 'Change picture' }).click();
  await a.getByRole('button', { name: 'Remove' }).click();
  await expect(a.locator('.avatar img')).toHaveCount(0);
});
