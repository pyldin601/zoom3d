import { beforeEach, expect, test, vi } from 'vitest';
import { asAudioContext, FakeAudioContext, type FakeNode } from '../audio/fake-audio';
import { BOOMBOX_SELF_GAIN, type Boombox, createBoombox } from './boombox';

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
const file = { name: 'song.mp3' };

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
  expect([input.type, input.accept, input.hidden]).toEqual(['file', 'audio/*', true]);
  box.toggle();
  expect(input.click).toHaveBeenCalledTimes(1);
  expect(onTrack).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
  expect(box.playing()).toBe(false);
});

test('B releases pointer lock before opening the picker', () => {
  // Chrome may not show a file chooser while the pointer is locked, and picking a file needs a cursor.
  box.toggle();
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

test('the graph splits to the stream and to the speakers at BOOMBOX_SELF_GAIN, built once', async () => {
  expect(BOOMBOX_SELF_GAIN).toBe(0.5);
  await pickAndPlay();
  box.toggle();
  await pickAndPlay();
  const sources = ctx.byKind('element-source');
  expect(sources).toHaveLength(1);
  const [toStream, toSelf] = (sources[0] as FakeNode).connections as (FakeNode & { gain?: { value: number } })[];
  expect(toStream?.kind).toBe('stream-destination');
  expect(toSelf?.kind).toBe('gain');
  expect(toSelf?.gain?.value).toBe(0.5);
  expect(toSelf?.connections).toEqual([ctx.destination]);
});

for (const [name, end] of [
  ['B while playing stops it', () => box.toggle()],
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
    box.toggle();
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
  box.toggle();
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
