// The lobby's mic meter (lobby spec §4.4): an AnalyserNode on the mic, read once a frame into one reused buffer.

/** RMS of the samples, scaled ×4 so speech fills the range, clamped to 0..1. */
export function rmsLevel(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as number;
    sum += s * s;
  }
  const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
  return Math.min(1, rms * 4);
}

/** Width in px of the level ring around the lobby disc. */
export function ringWidth(level: number): number {
  return Math.round(Math.min(1, Math.max(0, level)) * 6);
}

export interface MicLevel {
  level(): number;
  setTrack(track: MediaStreamTrack | null): void;
  dispose(): void;
}

export function createMicLevel(ctx: AudioContext): MicLevel {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const samples = new Float32Array(analyser.fftSize);
  let source: MediaStreamAudioSourceNode | null = null;
  let current: MediaStreamTrack | null = null;
  return {
    level() {
      if (!source) {
        return 0;
      }
      analyser.getFloatTimeDomainData(samples);
      return rmsLevel(samples);
    },
    setTrack(track) {
      if (track === current) {
        return;
      }
      current = track;
      source?.disconnect();
      source = track ? ctx.createMediaStreamSource(new MediaStream([track])) : null;
      source?.connect(analyser);
    },
    dispose() {
      source?.disconnect();
      source = null;
      current = null;
    },
  };
}
