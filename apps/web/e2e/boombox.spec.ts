import { expect, type Page, test } from '@playwright/test';
import { createAndJoin, joinAs } from './join';

type GameWindow = {
  __game: {
    session: { peers: Map<string, { info: { name: string; boombox: boolean } }> } | null;
    audio: { inputLevel(id: string): number } | null;
    call: { stats(id: string): Promise<{ boomboxBytesReceived: number } | null> } | null;
  };
};

/** 16-bit mono 48 kHz PCM: noise plus a tone. Noise keeps Opus VBR at its target; a pure sine undershoots. */
function wav(seconds = 4): Buffer {
  const rate = 48_000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    const s = 0.3 * noise + 0.2 * Math.sin((2 * Math.PI * 440 * i) / rate);
    buf.writeInt16LE(Math.round(s * 32_767), 44 + i * 2);
  }
  return buf;
}

const peerId = (page: Page, name: string) =>
  page.evaluate((n) => {
    const g = (window as unknown as GameWindow).__game;
    return [...(g.session?.peers.entries() ?? [])].find(([, p]) => p.info.name === n)?.[0] ?? null;
  }, name);

const boomboxOf = (page: Page, name: string) =>
  page.evaluate((n) => {
    const g = (window as unknown as GameWindow).__game;
    return [...(g.session?.peers.values() ?? [])].find((p) => p.info.name === n)?.info.boombox ?? null;
  }, name);

/** Highest engine input level of `key` over `ms`, sampled every 50 ms. */
const peakLevel = (page: Page, key: string, ms: number) =>
  page.evaluate(
    async ([k, duration]) => {
      const g = (window as unknown as GameWindow).__game;
      let peak = 0;
      const end = performance.now() + (duration as number);
      while (performance.now() < end) {
        peak = Math.max(peak, g.audio?.inputLevel(k as string) ?? 0);
        await new Promise((r) => setTimeout(r, 50));
      }
      return peak;
    },
    [key, ms] as const
  );

/** Received boombox bitrate from `id` in bits/s, over two seconds. */
const boomboxBitrate = (page: Page, id: string) =>
  page.evaluate(async (peer) => {
    const g = (window as unknown as GameWindow).__game;
    const first = (await g.call?.stats(peer))?.boomboxBytesReceived ?? 0;
    await new Promise((r) => setTimeout(r, 2000));
    const second = (await g.call?.stats(peer))?.boomboxBytesReceived ?? 0;
    return ((second - first) * 8) / 2;
  }, id);

async function play(page: Page, seconds: number) {
  // Waiting first turns on file-chooser interception, which is asynchronous: a B pressed right
  // after it can beat it, and the dialog then goes unseen.
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#stage').click();
  await page.keyboard.press('KeyB');
  await (await chooser).setFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav(seconds) });
}

test('a boombox plays to the room at music quality and shows on the carrier', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');
  await expect.poll(() => peerId(b, 'Ada')).not.toBeNull();
  const ada = (await peerId(b, 'Ada')) as string;

  await play(a, 8);
  await expect.poll(() => boomboxOf(b, 'Ada'), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => peakLevel(b, `boombox:${ada}`, 1500), { timeout: 20_000 }).toBeGreaterThan(0.005);
  // Spec §5.3: 128 kbps mono Opus, against the ~32 kbps speech default.
  expect(await boomboxBitrate(b, ada)).toBeGreaterThan(80_000);

  await a.keyboard.press('KeyB');
  await expect.poll(() => boomboxOf(b, 'Ada'), { timeout: 10_000 }).toBe(false);
});

test('the track ending turns the boombox off', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const url = await createAndJoin(a, 'Ada');
  await b.goto(url);
  await joinAs(b, 'Bob');
  await expect.poll(() => peerId(b, 'Ada')).not.toBeNull();

  await play(a, 1);
  await expect.poll(() => boomboxOf(b, 'Ada'), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => boomboxOf(b, 'Ada'), { timeout: 10_000 }).toBe(false);
});
