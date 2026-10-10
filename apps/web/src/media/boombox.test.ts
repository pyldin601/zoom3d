import { beforeEach, expect, test, vi } from 'vitest';
import { asAudioContext, FakeAudioContext, type FakeNode } from '../audio/fake-audio';
import { BOOMBOX_ACCEPT, BOOMBOX_SELF_GAIN, type Boombox, createBoombox } from './boombox';

class FakeElement {
  private listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn();
    }
  }
}

class FakeInput extends FakeElement {
  type = '';
  accept = '';
  hidden = false;
  value = '';
  files: unknown[] = [];
  click = vi.fn();
}

class FakeAudio extends FakeElement {
  src = '';
  currentTime = 0;
  duration = Number.NaN;
  loop = true;
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') {
      this.src = '';
    }
  });
  pending: { resolve: () => void; reject: (err: Error) => void } | null = null;
  play = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        this.pending = { resolve, reject };
      })
  );
}

let ctx: FakeAudioContext;
let input: FakeInput;
let audio: FakeAudio;
let created: string[];
let revoked: string[];
let onTrack: ReturnType<typeof vi.fn<(track: MediaStreamTrack | null) => void>>;
let onChange: ReturnType<typeof vi.fn<(on: boolean) => void>>;
let box: Boombox;
let order: string[];

const flush = () => new Promise((r) => setTimeout(r, 0));
const file = { name: 'Song – live.mp3', type: 'audio/mpeg' };

beforeEach(() => {
  ctx = new FakeAudioContext();
  input = new FakeInput();
  audio = new FakeAudio();
  created = [];
  revoked = [];
  onTrack = vi.fn<(track: MediaStreamTrack | null) => void>();
  onChange = vi.fn<(on: boolean) => void>();
  order = [];
  input.click.mockImplementation(() => order.push('click'));
  const container = {
    ownerDocument: {
      createElement: (tag: string) => (tag === 'input' ? input : audio),
      exitPointerLock: () => order.push('exitPointerLock'),
    },
    append: vi.fn(),
  };
  box = createBoombox({
    ctx: asAudioContext(ctx),
    container: container as unknown as HTMLElement,
    onTrack,
    onChange,
    urls: {
      create: () => {
        created.push(`blob:${created.length}`);
        return created.at(-1) as string;
      },
      revoke: (url) => revoked.push(url),
    },
  });
});

/** Picks `file` and lets play() resolve. */
async function pickAndPlay() {
  input.files = [file];
  input.dispatch('change');
  audio.pending?.resolve();
  await flush();
}

test('B when off opens an audio file picker and changes nothing else', () => {
  expect([input.type, input.accept, input.hidden]).toEqual(['file', BOOMBOX_ACCEPT, true]);
  box.toggle(true);
  expect(input.click).toHaveBeenCalledTimes(1);
  expect(onTrack).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
  expect(box.playing()).toBe(false);
});

test('the picker offers only formats every browser plays, by MIME type and extension', () => {
  expect(BOOMBOX_ACCEPT.split(',')).toEqual([
    'audio/mpeg',
    '.mp3',
    'audio/mp4',
    '.m4a',
    'audio/aac',
    '.aac',
    'audio/wav',
    '.wav',
    'audio/flac',
    '.flac',
  ]);
});

test.each([
  { name: 'cat.jpg', type: 'image/jpeg' },
  { name: 'clip.mp4', type: 'video/mp4' },
  { name: 'notes.txt', type: '' },
  { name: 'song.wma', type: 'audio/x-ms-wma' },
  // Patchy in Safari, so left out even where this browser could play them.
  { name: 'song.ogg', type: 'audio/ogg' },
  { name: 'voice.opus', type: '' },
  { name: 'song.weba', type: 'audio/webm' },
])('a pick outside the supported formats ($name) is ignored', async (picked) => {
  input.files = [picked];
  input.dispatch('change');
  await flush();
  expect(audio.play).not.toHaveBeenCalled();
  expect(created).toEqual([]);
  expect(box.title()).toBeNull();
  expect(input.value).toBe('');
  // Still off, so B opens the picker again.
  box.toggle(true);
  expect(input.click).toHaveBeenCalledTimes(1);
});

test.each([
  // Some systems report no type for .flac, and macOS reports .m4a as audio/x-m4a.
  { name: 'Track.FLAC', type: '' },
  { name: 'tune.m4a', type: 'audio/x-m4a' },
  { name: 'tone.wav', type: 'audio/x-wav' },
])('a supported file ($name) is recognised by its extension or a MIME alias', (picked) => {
  input.files = [picked];
  input.dispatch('change');
  expect(audio.play).toHaveBeenCalledTimes(1);
});

test('B releases pointer lock before opening the picker', () => {
  // Chrome may not show a file chooser while the pointer is locked, and picking a file needs a cursor.
  box.toggle(true);
  expect(order).toEqual(['exitPointerLock', 'click']);
});

test('picking a file plays it once and sends the track', async () => {
  input.value = 'C:\\fakepath\\song.mp3';
  await pickAndPlay();
  expect(audio.src).toBe('blob:0');
  expect(audio.loop).toBe(false);
  expect(onTrack).toHaveBeenCalledWith(ctx.streamTrack);
  expect(onChange).toHaveBeenCalledWith(true);
  expect(box.playing()).toBe(true);
  expect(input.value).toBe('');
});

test('the graph goes through the volume, then splits to the stream and to the speakers, built once', async () => {
  expect(BOOMBOX_SELF_GAIN).toBe(0.5);
  await pickAndPlay();
  box.toggle(true);
  await pickAndPlay();
  const sources = ctx.byKind('element-source');
  expect(sources).toHaveLength(1);
  const [volume] = (sources[0] as FakeNode).connections as (FakeNode & { gain: { value: number } })[];
  expect(volume?.kind).toBe('gain');
  expect(volume?.gain.value).toBe(1);
  const [toStream, toSelf] = (volume as FakeNode).connections as (FakeNode & { gain?: { value: number } })[];
  expect(toStream?.kind).toBe('stream-destination');
  expect(toSelf?.kind).toBe('gain');
  expect(toSelf?.gain?.value).toBe(0.5);
  expect(toSelf?.connections).toEqual([ctx.destination]);
});

for (const [name, end] of [
  ['B while playing stops it', () => box.toggle(true)],
  ['the track ending stops it', () => audio.dispatch('ended')],
  ['an error stops it', () => audio.dispatch('error')],
] as const) {
  test(name, async () => {
    await pickAndPlay();
    end();
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.src).toBe('');
    expect(revoked).toEqual(['blob:0']);
    expect(onTrack).toHaveBeenLastCalledWith(null);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(box.playing()).toBe(false);
    box.toggle(true);
    expect(input.click).toHaveBeenCalledTimes(1);
  });
}

test('an unplayable file leaves it off', async () => {
  input.files = [file];
  input.dispatch('change');
  audio.pending?.reject(new Error('NotSupportedError'));
  await flush();
  expect(onChange).not.toHaveBeenCalled();
  expect(onTrack).not.toHaveBeenCalled();
  expect(revoked).toEqual(['blob:0']);
  expect(box.playing()).toBe(false);
});

test('B while the file is still starting cancels it for good', async () => {
  input.files = [file];
  input.dispatch('change');
  box.toggle(true);
  audio.pending?.resolve();
  await flush();
  expect(onChange).not.toHaveBeenCalled();
  expect(box.playing()).toBe(false);
  expect(revoked).toEqual(['blob:0']);
});

test('a cancelled pick changes nothing', () => {
  input.files = [];
  input.dispatch('change');
  expect(audio.play).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
  expect(created).toEqual([]);
});

test('outside a room B never opens the picker, but still stops the music', async () => {
  box.toggle(false);
  expect(input.click).not.toHaveBeenCalled();
  await pickAndPlay();
  box.toggle(false);
  expect(onChange).toHaveBeenLastCalledWith(false);
  expect(box.playing()).toBe(false);
});

const volumeGain = () =>
  ((ctx.byKind('element-source')[0] as FakeNode).connections[0] as FakeNode & { gain: { value: number } }).gain;

test('setVolume turns down both what we hear and what we send, clamped to 0..1', async () => {
  await pickAndPlay();
  box.setVolume(0.25);
  expect(volumeGain().value).toBe(0.25);
  expect(box.volume()).toBe(0.25);
  box.setVolume(7);
  expect(volumeGain().value).toBe(1);
  box.setVolume(-1);
  expect(volumeGain().value).toBe(0);
});

test('a volume set before the first track applies to it, and is kept for the next', async () => {
  box.setVolume(0.4);
  await pickAndPlay();
  expect(volumeGain().value).toBe(0.4);
  box.toggle(true);
  await pickAndPlay();
  expect(volumeGain().value).toBe(0.4);
});

test('progress and title follow the playing track, and are empty when off', async () => {
  expect(box.progress()).toEqual({ current: 0, duration: 0 });
  expect(box.title()).toBeNull();
  await pickAndPlay();
  expect(box.progress()).toEqual({ current: 0, duration: 0 });
  audio.duration = 200;
  audio.currentTime = 12.5;
  expect(box.progress()).toEqual({ current: 12.5, duration: 200 });
  expect(box.title()).toBe('Song – live.mp3');
  box.toggle(true);
  expect(box.title()).toBeNull();
  expect(box.progress()).toEqual({ current: 0, duration: 0 });
});

test('seek moves the playing track, clamped to its length, and does nothing when off', async () => {
  box.seek(30);
  expect(audio.currentTime).toBe(0);
  await pickAndPlay();
  audio.duration = 200;
  box.seek(90);
  expect(audio.currentTime).toBe(90);
  box.seek(500);
  expect(audio.currentTime).toBe(200);
  box.seek(-3);
  expect(audio.currentTime).toBe(0);
});
