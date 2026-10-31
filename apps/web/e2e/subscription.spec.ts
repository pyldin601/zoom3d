import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs, lookAt } from './join';

type GameWindow = {
  __game: {
    player: { angle: number };
    session: { peers: Map<string, { info: { name: string; color: string } }> } | null;
    call: {
      faceOf(id: string): Uint32Array | null;
      stats(id: string): Promise<{ bytesReceived: number } | null>;
    } | null;
  };
};

/** What `page` receives from the peer named `name`: bytes so far, video tracks in its element, a face corner. */
const received = (page: Page, name: string) =>
  page.evaluate(async (peerName) => {
    const g = (window as unknown as GameWindow).__game;
    const entry = [...(g.session?.peers.entries() ?? [])].find(([, p]) => p.info.name === peerName);
    if (!entry || !g.call) {
      return null;
    }
    const [id, peer] = entry;
    const video = document.querySelector<HTMLVideoElement>(`#media video[data-peer="${id}"]`);
    const stream = video?.srcObject as MediaStream | null | undefined;
    const n = Number.parseInt(peer.info.color.slice(1), 16);
    // The initials disc is filled with the peer's colour (packed like rgb(): ABGR).
    const initials = (0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)) >>> 0;
    return {
      bytes: (await g.call.stats(id))?.bytesReceived ?? 0,
      videoTracks: stream?.getVideoTracks().length ?? 0,
      initials: g.call.faceOf(id)?.[0] === initials,
    };
  }, name);

const growth = async (page: Page, name: string, ms: number) => {
  const before = (await received(page, name))?.bytes ?? 0;
  await page.waitForTimeout(ms);
  return ((await received(page, name))?.bytes ?? 0) - before;
};

test('a face out of view stops arriving and comes back, never as initials, when looked at again', async ({
  browser,
}) => {
  // About 8 s of it is deliberate waiting (holds, stalls, byte counts).
  test.setTimeout(60_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');
  // Ada's mic is muted so the bytes Bob gets from her are (almost) all video.
  await a.getByRole('button', { name: 'Mic on' }).click();

  await lookAt(b, 'Ada');
  await expect.poll(async () => (await received(b, 'Ada'))?.videoTracks, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await received(b, 'Ada'))?.initials, { timeout: 15_000 }).toBe(false);
  expect(await growth(b, 'Ada', 1000)).toBeGreaterThan(2000);

  // Turn away: after the 1 s hold the face is unsubscribed and stops arriving.
  await b.evaluate(() => {
    (window as unknown as GameWindow).__game.player.angle += Math.PI;
  });
  await expect.poll(async () => (await received(b, 'Ada'))?.videoTracks, { timeout: 5000 }).toBe(0);
  await b.waitForTimeout(500);
  expect(await growth(b, 'Ada', 1500)).toBeLessThan(1500);
  // Out of view for longer than a stall, the face still holds its last frame.
  await b.waitForTimeout(2500);
  expect((await received(b, 'Ada'))?.initials).toBe(false);

  // Turn back: it resumes, and the face never falls back to initials on the way.
  await lookAt(b, 'Ada');
  const seen: boolean[] = [];
  for (let i = 0; i < 20; i++) {
    seen.push((await received(b, 'Ada'))?.initials ?? true);
    await b.waitForTimeout(100);
  }
  expect(seen).not.toContain(true);
  await expect.poll(async () => (await received(b, 'Ada'))?.videoTracks, { timeout: 5000 }).toBe(1);
  expect(await growth(b, 'Ada', 1000)).toBeGreaterThan(2000);
});

test('the backtick panel’s face dots show whether anyone receives the player’s face', async ({ browser }) => {
  test.setTimeout(60_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await a.locator('#stage').click();
  await a.keyboard.press('Backquote');
  const sent = a.locator('.console-panel .face-sent .dots span.on');
  await expect(a.locator('.console-panel .face-sent .dots span')).toHaveCount(3);
  // Alone: dynacast pauses every size.
  await expect(sent).toHaveCount(0, { timeout: 15_000 });

  await b.goto(url);
  await joinAs(b, 'Bob');
  await lookAt(b, 'Ada');
  await expect.poll(() => sent.count(), { timeout: 15_000 }).toBeGreaterThan(0);

  // Bob turns away: once he drops her face, nobody receives any size.
  await b.evaluate(() => {
    (window as unknown as GameWindow).__game.player.angle += Math.PI;
  });
  await expect(sent).toHaveCount(0, { timeout: 15_000 });
});
