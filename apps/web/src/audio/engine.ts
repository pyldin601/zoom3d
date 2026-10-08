// Spatial voice engine (spec §9): per-peer source → lowpass → (dry → HRTF panner) + (send → shared reverb).
// Distance comes from our own curve (the panner only gives direction); walls muffle and attenuate.
import {
  type AudioSettings,
  DEFAULT_AUDIO_SETTINGS,
  type GameMap,
  hasLineOfSight,
  MUFFLE_OPEN_HZ,
  OCCLUSION_INTERVAL_MS,
  type PlayerState,
  TAU_OCCLUSION,
  TAU_POSITION,
  voiceGains,
} from '@zoom3d/shared';

const ANALYSER_SIZE = 512;
const SPEAKING_FLOOR = 0.01;
const SPEAKING_RANGE = 0.09;
const SPEAKING_RELEASE_S = 0.3;

export interface AudioEngine {
  attach(peerId: string, stream: MediaStream): void;
  detach(peerId: string): void;
  update(now: number, listener: PlayerState, sources: ReadonlyMap<string, { x: number; y: number }>): void;
  /** 0..1 speaking indicator. */
  speaking(peerId: string): number;
  /** Latest RMS of the voice before any gain. */
  inputLevel(peerId: string): number;
  settings(): AudioSettings;
  setSettings(s: AudioSettings): void;
  resume(): Promise<void>;
  dispose(): void;
}

/** Stereo decorrelated noise decaying to −60 dB at `seconds`, after a silent pre-delay. */
export function makeImpulse(ctx: BaseAudioContext, seconds = 0.8, preDelay = 0.01): AudioBuffer {
  const rate = ctx.sampleRate;
  const offset = Math.floor(preDelay * rate);
  const buffer = ctx.createBuffer(2, offset + Math.floor(seconds * rate), rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = offset; i < data.length; i++) {
      const t = (i - offset) / rate;
      data[i] = (Math.random() * 2 - 1) * Math.exp((-6.91 * t) / seconds);
    }
  }
  return buffer;
}

/** Instant attack, exponential release; RMS below the floor reads as silence. */
export function speakingLevel(prev: number, rms: number, dtSeconds: number): number {
  const target = Math.min(Math.max((rms - SPEAKING_FLOOR) / SPEAKING_RANGE, 0), 1);
  if (target >= prev) return target;
  return Math.max(target, prev * Math.exp(-Math.max(dtSeconds, 0) / SPEAKING_RELEASE_S));
}

interface Voice {
  stream: MediaStream;
  source: AudioNode;
  analyser: AnalyserNode;
  filter: BiquadFilterNode;
  dry: GainNode;
  send: GainNode;
  panner: PannerNode;
  samples: Float32Array<ArrayBuffer>;
  occluded: boolean;
  lastOcclusionAt: number;
  rms: number;
  speaking: number;
}

export function createAudioEngine(opts: {
  ctx: AudioContext;
  map: GameMap;
  settings?: AudioSettings;
}): AudioEngine {
  const { ctx, map } = opts;
  let settings = opts.settings ?? DEFAULT_AUDIO_SETTINGS;
  const voices = new Map<string, Voice>();
  let lastUpdate: number | null = null;

  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = settings.reverb;
  reverb.connect(reverbGain).connect(ctx.destination);

  const setListener = (p: PlayerState, t: number) => {
    const l = ctx.listener;
    const fx = Math.cos(p.angle);
    const fz = Math.sin(p.angle);
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, TAU_POSITION);
      l.positionY.setTargetAtTime(0, t, TAU_POSITION);
      l.positionZ.setTargetAtTime(p.y, t, TAU_POSITION);
      l.forwardX.setTargetAtTime(fx, t, TAU_POSITION);
      l.forwardY.setTargetAtTime(0, t, TAU_POSITION);
      l.forwardZ.setTargetAtTime(fz, t, TAU_POSITION);
      l.upX.setTargetAtTime(0, t, TAU_POSITION);
      l.upY.setTargetAtTime(1, t, TAU_POSITION);
      l.upZ.setTargetAtTime(0, t, TAU_POSITION);
    } else {
      l.setPosition(p.x, 0, p.y);
      l.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  };

  const detach = (peerId: string) => {
    const v = voices.get(peerId);
    if (!v) return;
    for (const node of [v.source, v.analyser, v.filter, v.dry, v.send, v.panner]) node.disconnect();
    voices.delete(peerId);
  };

  return {
    attach(peerId, stream) {
      const existing = voices.get(peerId);
      if (existing?.stream === stream) return;
      if (existing) detach(peerId);

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = ANALYSER_SIZE;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = MUFFLE_OPEN_HZ;
      const dry = ctx.createGain();
      dry.gain.value = 0;
      const send = ctx.createGain();
      send.gain.value = 0;
      const panner = ctx.createPanner();
      panner.panningModel = settings.panning;
      panner.distanceModel = 'linear';
      panner.rolloffFactor = 0;

      source.connect(analyser);
      source.connect(filter);
      filter.connect(dry);
      dry.connect(panner);
      panner.connect(ctx.destination);
      filter.connect(send);
      send.connect(reverb);

      voices.set(peerId, {
        stream,
        source,
        analyser,
        filter,
        dry,
        send,
        panner,
        samples: new Float32Array(ANALYSER_SIZE),
        occluded: false,
        lastOcclusionAt: Number.NEGATIVE_INFINITY,
        rms: 0,
        speaking: 0,
      });
    },

    detach,

    update(now, listener, sources) {
      const t = ctx.currentTime;
      const dt = lastUpdate === null ? 0 : (now - lastUpdate) / 1000;
      lastUpdate = now;
      setListener(listener, t);

      for (const [peerId, v] of voices) {
        v.analyser.getFloatTimeDomainData(v.samples);
        let sum = 0;
        for (let i = 0; i < v.samples.length; i++) sum += (v.samples[i] as number) ** 2;
        v.rms = Math.sqrt(sum / v.samples.length);
        v.speaking = speakingLevel(v.speaking, v.rms, dt);

        const pos = sources.get(peerId);
        if (!pos) {
          v.dry.gain.setTargetAtTime(0, t, TAU_POSITION);
          v.send.gain.setTargetAtTime(0, t, TAU_POSITION);
          continue;
        }

        let tau = TAU_POSITION;
        if (now - v.lastOcclusionAt >= OCCLUSION_INTERVAL_MS) {
          v.lastOcclusionAt = now;
          const occluded = !hasLineOfSight(map, listener.x, listener.y, pos.x, pos.y);
          if (occluded !== v.occluded) {
            v.occluded = occluded;
            tau = TAU_OCCLUSION;
            v.filter.frequency.setTargetAtTime(
              occluded ? settings.muffleHz : MUFFLE_OPEN_HZ,
              t,
              TAU_OCCLUSION,
            );
          }
        }

        const g = voiceGains(Math.hypot(pos.x - listener.x, pos.y - listener.y), v.occluded, settings);
        v.dry.gain.setTargetAtTime(g.dry, t, tau);
        v.send.gain.setTargetAtTime(g.send, t, tau);
        v.panner.positionX.setTargetAtTime(pos.x, t, TAU_POSITION);
        v.panner.positionY.setTargetAtTime(0, t, TAU_POSITION);
        v.panner.positionZ.setTargetAtTime(pos.y, t, TAU_POSITION);
      }
    },

    speaking: (peerId) => voices.get(peerId)?.speaking ?? 0,
    inputLevel: (peerId) => voices.get(peerId)?.rms ?? 0,
    settings: () => settings,

    setSettings(s) {
      settings = s;
      const t = ctx.currentTime;
      reverbGain.gain.setTargetAtTime(s.reverb, t, TAU_POSITION);
      for (const v of voices.values()) {
        v.panner.panningModel = s.panning;
        if (v.occluded) v.filter.frequency.setTargetAtTime(s.muffleHz, t, TAU_OCCLUSION);
      }
    },

    async resume() {
      if (ctx.state === 'suspended') await ctx.resume();
    },

    dispose() {
      for (const id of [...voices.keys()]) detach(id);
      reverb.disconnect();
      reverbGain.disconnect();
    },
  };
}
