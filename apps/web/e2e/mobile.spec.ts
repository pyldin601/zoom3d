import { type Browser, expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

// A portrait phone (mobile spec §7): Chrome's mobile emulation reports (pointer: coarse), so the page is in touch mode.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

type GameWindow = {
  __game: {
    map: { width: number; tiles: Uint8Array };
    player: { x: number; y: number; angle: number };
    session: {
      peers: Map<string, { info: { name: string; held: string | null }; gesture: { kind: string } | null }>;
    } | null;
  };
};

const gameCanvas = (page: Page) =>
  page.evaluate(() => {
    const game = document.getElementById('game') as HTMLCanvasElement;
    return [game.width, game.height];
  });

/** Dispatches a touch pointer event on the element matching `selector` (or the window), at viewport (x, y). */
function touchAt(page: Page, type: string, selector: string | null, x: number, y: number, pointerId = 1) {
  return page.evaluate(
    ({ type, selector, x, y, pointerId }) => {
      const target = selector ? (document.querySelector(selector) as Element) : window;
      const init = {
        bubbles: true,
        pointerId,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        isPrimary: pointerId === 1,
      };
      target.dispatchEvent(new PointerEvent(type, init));
    },
    { type, selector, x, y, pointerId }
  );
}

async function phonePage(browser: Browser): Promise<Page> {
  return (await browser.newContext(PHONE)).newPage();
}

test.describe('portrait phone', () => {
  test.use(PHONE);

  test('the page is in touch mode', async ({ page }) => {
    await page.goto('/');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.locator('html')).toHaveClass(/touch/);
  });

  test('the frame fills a portrait phone with a 296x640 buffer', async ({ page }) => {
    await page.goto('/');
    await expect.poll(() => page.locator('#stage').boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    expect(await gameCanvas(page)).toEqual([296, 640]);
  });

  test('Start a party and Join are on screen and at least 44 px tall', async ({ page }) => {
    await page.goto('/');
    const start = page.getByRole('button', { name: 'Start a party' });
    const startBox = await start.boundingBox();
    expect(startBox?.height).toBeGreaterThanOrEqual(44);
    expect((startBox?.y ?? 0) + (startBox?.height ?? 0)).toBeLessThanOrEqual(844);
    await start.click();
    const joinBox = await page.getByRole('button', { name: 'Join' }).boundingBox();
    expect(joinBox?.height).toBeGreaterThanOrEqual(44);
    expect((joinBox?.y ?? 0) + (joinBox?.height ?? 0)).toBeLessThanOrEqual(844);
  });

  test('the pad moves forward and a drag on the view turns', async ({ page }) => {
    await createAndJoin(page, 'Pat');
    // Face an open tile so forward isn't blocked by a wall at spawn.
    const start = await page.evaluate(() => {
      const g = (window as unknown as GameWindow).__game;
      const free = (x: number, y: number) => g.map.tiles[Math.floor(y) * g.map.width + Math.floor(x)] === 0;
      for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        if (free(g.player.x + Math.cos(angle) * 1.2, g.player.y + Math.sin(angle) * 1.2)) {
          g.player.angle = angle;
          break;
        }
      }
      return { ...g.player };
    });
    const pad = await page.locator('.touch-pad').boundingBox();
    if (!pad) {
      throw new Error('no touch pad');
    }
    await expect(page.locator('.touch-pad')).toHaveCSS('opacity', '0.35');
    await touchAt(page, 'pointerdown', '.touch-pad', pad.x + pad.width / 2, pad.y + 4);
    await expect(page.locator('.touch-pad')).toHaveClass(/active/);
    await page.waitForTimeout(400);
    await touchAt(page, 'pointerup', null, pad.x + pad.width / 2, pad.y + 4);
    const moved = await page.evaluate(() => ({ ...(window as unknown as GameWindow).__game.player }));
    const along = (moved.x - start.x) * Math.cos(start.angle) + (moved.y - start.y) * Math.sin(start.angle);
    expect(along).toBeGreaterThan(0.2);

    await touchAt(page, 'pointerdown', '#game', 100, 300, 2);
    await touchAt(page, 'pointermove', null, 300, 300, 2);
    await touchAt(page, 'pointerup', null, 300, 300, 2);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as GameWindow).__game.player.angle))
      .toBeCloseTo(start.angle + (200 / 195) * (Math.PI / 2), 1);
  });

  test('rotating mid-room rebuilds the frame', async ({ page }) => {
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    await createAndJoin(page, 'Rory');
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => gameCanvas(page)).toEqual([640, 296]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => gameCanvas(page)).toEqual([296, 640]);
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });
});

test('a drink is picked from the tray and sipped with the drink button', async ({ browser }) => {
  const phone = await phonePage(browser);
  const desk = await (await browser.newContext()).newPage();
  const url = await createAndJoin(phone, 'Pip');
  await desk.goto(url);
  await joinAs(desk, 'Dee');

  await phone.locator('.more').click();
  await phone.getByRole('button', { name: 'Beer' }).click();
  await expect(phone.locator('.tray')).toBeHidden();
  const drink = phone.locator('.drink');
  await expect(drink).toBeVisible();
  const box = await drink.boundingBox();
  if (!box) {
    throw new Error('no drink button');
  }
  const pip = () =>
    desk.evaluate(() => {
      const peers = [...((window as unknown as GameWindow).__game.session?.peers.values() ?? [])];
      const p = peers.find((q) => q.info.name === 'Pip');
      return { held: p?.info.held ?? null, gesture: p?.gesture?.kind ?? null };
    });
  await expect.poll(pip, { timeout: 5000 }).toMatchObject({ held: 'beer' });
  await touchAt(phone, 'pointerdown', '.drink', box.x + box.width / 2, box.y + box.height / 2);
  await phone.waitForTimeout(100);
  await touchAt(phone, 'pointerup', '.drink', box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(pip, { timeout: 5000 }).toEqual({ held: 'beer', gesture: 'sip' });
});

test.describe('desktop with a touchscreen', () => {
  test('first touch on desktop shows controls, frame stays 16:9', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await createAndJoin(page, 'Lee');
    await expect(page.locator('.touch-pad')).toHaveCount(0);
    await touchAt(page, 'pointerdown', '#game', 640, 360);
    await touchAt(page, 'pointerup', null, 640, 360);
    await expect(page.locator('.touch-pad')).toBeVisible();
    const box = await page.locator('#stage').boundingBox();
    expect(Math.abs((box?.width ?? 0) / (box?.height ?? 1) - 16 / 9)).toBeLessThan(0.01);
    expect(await gameCanvas(page)).toEqual([640, 360]);
  });
});
