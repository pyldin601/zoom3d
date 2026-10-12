// Browser side of the load test: real Chrome with a fake camera joins the room on prod and reports the game's frame
// rate. `extra` more fake-camera browsers join first, so the probe also decodes some faces.
// Usage (from apps/web): node load-test/fps.ts <roomUrl> <extra> <seconds>
import { chromium, type Page } from '@playwright/test';

const [roomUrl, extraArg, secArg] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
async function join(name: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto(roomUrl);
  await page.getByPlaceholder('Your name').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await page.waitForTimeout(3000);
  return page;
}
for (let i = 0; i < Number(extraArg); i++) {
  await join(`Cam ${i + 1}`);
}
const probe = await join('FPS probe');
const end = Date.now() + Number(secArg) * 1000;
while (Date.now() < end) {
  const r = await probe.evaluate(
    () =>
      new Promise<{ fps: number; worstMs: number; p95Ms: number }>((resolve) => {
        const times: number[] = [];
        const t0 = performance.now();
        const tick = (t: number) => {
          times.push(t);
          if (t - t0 < 10_000) {
            requestAnimationFrame(tick);
          } else {
            const gaps = times
              .slice(1)
              .map((x, i) => x - (times[i] as number))
              .sort((a, b) => a - b);
            resolve({
              fps: (times.length - 1) / ((t - (times[0] as number)) / 1000),
              worstMs: gaps.at(-1) ?? 0,
              p95Ms: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
            });
          }
        };
        requestAnimationFrame(tick);
      })
  );
  console.log(`fps=${r.fps.toFixed(1)} frame p95=${r.p95Ms.toFixed(1)}ms worst=${r.worstMs.toFixed(0)}ms`);
}
await browser.close();
