import { expect, test } from '@playwright/test';

for (const [width, height] of [
  [1280, 720],
  [1280, 1024],
  [900, 1400],
  [1500, 600],
]) {
  test(`stage stays 16:9 and centred at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width as number, height: height as number });
    await page.goto('/');
    const stage = page.locator('#stage');
    await expect(stage).toHaveCSS('width', /px$/);
    const box = await stage.boundingBox();
    if (!box) {
      throw new Error('#stage has no box');
    }
    expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.01);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width as number);
    expect(box.y + box.height).toBeLessThanOrEqual(height as number);
    expect(Math.abs(box.x - ((width as number) - box.x - box.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y - ((height as number) - box.y - box.height))).toBeLessThanOrEqual(1);
    const { hudWidth, dpr } = await page.evaluate(() => ({
      hudWidth: (document.getElementById('hud') as HTMLCanvasElement).width,
      dpr: window.devicePixelRatio,
    }));
    expect(hudWidth).toBe(Math.round(box.width * dpr));
  });
}

test('stage re-fits after a resize', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.setViewportSize({ width: 700, height: 1200 });
  await expect
    .poll(async () => {
      const box = await page.locator('#stage').boundingBox();
      return box ? Math.round(box.width) : 0;
    })
    .toBe(688);
});
