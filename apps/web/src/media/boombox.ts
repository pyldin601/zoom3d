// The local boombox (boombox spec §3): B picks an audio file, which plays once. Its sound goes into
// Web Audio and splits two ways: a stream track for the mesh, and our own speakers, centred and dry.

/** How loud the carrier hears their own music; it's in their hand, not out in the room. */
export const BOOMBOX_SELF_GAIN = 0.5;

export interface Boombox {
  /** The B key: opens the file picker when off, stops when playing. */
  toggle(): void;
  playing(): boolean;
}

export interface BoomboxOptions {
  ctx: AudioContext;
  /** Hidden home for the file input and the <audio> element. */
  container: HTMLElement;
  onTrack(track: MediaStreamTrack | null): void;
  onChange(on: boolean): void;
  urls?: { create(file: Blob): string; revoke(url: string): void };
}

export function createBoombox(opts: BoomboxOptions): Boombox {
  const { ctx, container, onTrack, onChange } = opts;
  const urls = opts.urls ?? {
    create: (f: Blob) => URL.createObjectURL(f),
    revoke: (u: string) => URL.revokeObjectURL(u),
  };
  const doc = container.ownerDocument;
  const input = doc.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.hidden = true;
  // One element for the whole session: an element can feed only one MediaElementSource.
  const audio = doc.createElement('audio');
  audio.loop = false;
  container.append(input, audio);

  let state: 'off' | 'starting' | 'playing' = 'off';
  let url: string | null = null;
  /** Bumped by every start and stop, so a late play() result from an old attempt is ignored. */
  let attempt = 0;
  let track: MediaStreamTrack | null = null;

  const graph = (): MediaStreamTrack | null => {
    if (track) {
      return track;
    }
    const source = ctx.createMediaElementSource(audio);
    const stream = ctx.createMediaStreamDestination();
    const self = ctx.createGain();
    self.gain.value = BOOMBOX_SELF_GAIN;
    source.connect(stream);
    source.connect(self);
    self.connect(ctx.destination);
    track = stream.stream.getAudioTracks()[0] ?? null;
    return track;
  };

  const stop = () => {
    if (state === 'off') {
      return;
    }
    const wasOn = state === 'playing';
    state = 'off';
    attempt++;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (url) {
      urls.revoke(url);
      url = null;
    }
    if (wasOn) {
      onTrack(null);
      onChange(false);
    }
  };

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    // Reset so picking the same file again still fires change.
    input.value = '';
    if (!file || state !== 'off') {
      return;
    }
    state = 'starting';
    const mine = ++attempt;
    // Built before play() so the element never sounds outside the graph.
    const out = graph();
    url = urls.create(file);
    audio.src = url;
    audio.play().then(
      () => {
        if (mine !== attempt) {
          return;
        }
        state = 'playing';
        onTrack(out);
        onChange(true);
      },
      (err) => {
        if (mine !== attempt) {
          return;
        }
        console.warn('boombox could not play the file', err);
        stop();
      }
    );
  });
  audio.addEventListener('ended', stop);
  audio.addEventListener('error', stop);

  return {
    toggle() {
      if (state === 'off') {
        // Picking a file needs a cursor, and Chrome may not open a file chooser under pointer lock.
        doc.exitPointerLock?.();
        input.click();
      } else {
        stop();
      }
    },
    playing: () => state === 'playing',
  };
}
