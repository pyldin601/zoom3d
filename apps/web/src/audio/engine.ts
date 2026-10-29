// Spatial voice engine (spec §9): per-peer source → lowpass → (dry → HRTF panner) + (send → shared reverb). Synthesised
// sources, like the robot vacuum's hum, take the same path without the speaking analyser.
// Distance comes from our own curve (the panner only gives direction); walls muffle and attenuate.
// It runs every frame, so a param is only sent a new target when it changes (see `glide`).
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
/** RMS at or below this reads as silence. */
const SPEAKING_FLOOR = 0.01;
/** RMS this far above the floor reads as fully speaking. */
const SPEAKING_RANGE = 0.09;
/** Seconds for the speaking level to fall by a factor of e once the voice goes quiet. */
const SPEAKING_RELEASE_S = 0.3;
/** About 3 time constants: the occlusion glide is ~95% done. */
const OCCLUSION_SETTLE_MS = TAU_OCCLUSION * 3000;
/** About ln(1000): an exponential decay is down 60 dB after this many time constants. */
const DECAY_60_DB = 6.91;

/** Where a voice plays from. `sees`, when given, is the line of sight (through portals) and replaces the engine's own. */
export interface Source {
  x: number;
  y: number;
  sees?: boolean;
}

export interface AudioEngine {
  /** `owner` is whose position the voice plays from (default: `key`), e.g. a peer's boombox. */
  attach(key: string, stream: MediaStream, owner?: string): void;
  /** A synthesised source played from `owner`'s position through the voice path; no analyser, never "speaking". */
  attachNode(key: string, node: AudioNode, owner?: string): void;
  detach(peerId: string): void;
  /**
   * A synthesised sound heard at the same level wherever the listener stands: `node` goes straight out, carrying any
   * reverb of its own. The caller disconnects `node` when the sound is over.
   */
  playUnplaced(node: AudioNode): void;
  update(now: number, listener: PlayerState, sources: ReadonlyMap<string, Source>): void;
  /** 0..1 speaking indicator. */
  speaking(peerId: string): number;
  /** Latest RMS of the voice before any gain. */
  inputLevel(peerId: string): number;
  settings(): AudioSettings;
  resume(): Promise<void>;
  dispose(): void;
}

/**
 * Stereo decorrelated noise decaying to −60 dB at `seconds`, after a silent pre-delay.
 * Each channel has unit energy, so with `normalize = false` the reverb passes at 0 dB.
 */
export function makeImpulse(ctx: BaseAudioContext, seconds = 0.8, preDelay = 0.01): AudioBuffer {
  const rate = ctx.sampleRate;
  const offset = Math.floor(preDelay * rate);
  const buffer = ctx.createBuffer(2, offset + Math.floor(seconds * rate), rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let energy = 0;
    for (let i = offset; i < data.length; i++) {
      const t = (i - offset) / rate;
      const v = (Math.random() * 2 - 1) * Math.exp((-DECAY_60_DB * t) / seconds);
      data[i] = v;
      energy += v * v;
    }
    const scale = 1 / Math.sqrt(energy);
    for (let i = offset; i < data.length; i++) {
      data[i] = (data[i] as number) * scale;
    }
  }
  return buffer;
}

/** 0 for no samples. */
export function rootMeanSquare(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Instant attack, exponential release; RMS below the floor reads as silence. */
export function speakingLevel(prev: number, rms: number, dtSeconds: number): number {
  const target = Math.min(Math.max((rms - SPEAKING_FLOOR) / SPEAKING_RANGE, 0), 1);
  if (target >= prev) {
    return target;
  }
  return Math.max(target, prev * Math.exp(-Math.max(dtSeconds, 0) / SPEAKING_RELEASE_S));
}

/** The value a param was last sent towards, and with which time constant. */
interface Target {
  value: number;
  tau: number;
}

/** A param at rest at `value`: its default, or where a jump put it. */
const restingAt = (value: number): Target => ({ value, tau: TAU_POSITION });

/**
 * Glides `param` towards `value` with time constant `tau`, unless that is already its target. setTargetAtTime is
 * memoryless (from wherever the curve is, it approaches the target the same way), so sending the same target again
 * changes nothing but adds an event to the param's timeline, every frame.
 */
function glide(param: AudioParam, last: Target, value: number, t: number, tau: number): void {
  if (value === last.value && tau === last.tau) {
    return;
  }
  last.value = value;
  last.tau = tau;
  param.setTargetAtTime(value, t, tau);
}

/** Glides a position param, or jumps on the first placement so nothing sweeps in from the origin. */
function move(param: AudioParam, last: Target, value: number, t: number, jump: boolean): void {
  if (jump) {
    param.setValueAtTime(value, t);
    last.value = value;
    last.tau = TAU_POSITION;
  } else {
    glide(param, last, value, t, TAU_POSITION);
  }
}

/** Where a voice's sound comes from: a stream, measured for speaking, or a synthesised node. */
type VoiceInput =
  | { kind: 'stream'; stream: MediaStream; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer> }
  | { kind: 'node' };

interface Voice {
  input: VoiceInput;
  /** Key of the position in update's `sources`. */
  owner: string;
  source: AudioNode;
  filter: BiquadFilterNode;
  dry: GainNode;
  send: GainNode;
  panner: PannerNode;
  /** The last targets of the gains and of the panner's x and z (its y stays 0). */
  dryTarget: Target;
  sendTarget: Target;
  panX: Target;
  panZ: Target;
  occluded: boolean;
  lastOcclusionAt: number;
  /** Gains keep the slow occlusion time constant this long after a change. */
  occlusionChangedAt: number;
  /** False until the first positioned update, which jumps instead of gliding from the origin. */
  positioned: boolean;
  rms: number;
  speaking: number;
}

export function createAudioEngine(opts: { ctx: AudioContext; map: GameMap; settings?: AudioSettings }): AudioEngine {
  const { ctx, map } = opts;
  const settings = opts.settings ?? DEFAULT_AUDIO_SETTINGS;
  const voices = new Map<string, Voice>();
  let lastUpdate: number | null = null;
  let listenerPlaced = false;
  /** The last targets of the listener's position (x, z) and facing (x, z); the rest of its pose is constant. */
  const heard = { x: restingAt(0), z: restingAt(0), forwardX: restingAt(0), forwardZ: restingAt(0) };

  const reverb = ctx.createConvolver();
  // The browser's own normalization takes ~13 dB off; makeImpulse is already unit energy.
  reverb.normalize = false;
  reverb.buffer = makeImpulse(ctx);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = settings.reverb;
  reverb.connect(reverbGain).connect(ctx.destination);

  const setListener = (p: PlayerState, t: number) => {
    const l = ctx.listener;
    const fx = Math.cos(p.angle);
    const fz = Math.sin(p.angle);
    if (!l.positionX) {
      l.setPosition(p.x, 0, p.y);
      l.setOrientation(fx, 0, fz, 0, 1, 0);
      return;
    }
    const jump = !listenerPlaced;
    if (jump) {
      // At ear height 0, facing level with the head up: set once, they never change.
      l.positionY.setValueAtTime(0, t);
      l.forwardY.setValueAtTime(0, t);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    }
    move(l.positionX, heard.x, p.x, t, jump);
    move(l.positionZ, heard.z, p.y, t, jump);
    move(l.forwardX, heard.forwardX, fx, t, jump);
    move(l.forwardZ, heard.forwardZ, fz, t, jump);
    listenerPlaced = true;
  };

  const detach = (peerId: string) => {
    const v = voices.get(peerId);
    if (!v) {
      return;
    }
    const analyser = v.input.kind === 'stream' ? v.input.analyser : null;
    for (const node of [v.source, analyser, v.filter, v.dry, v.send, v.panner]) {
      node?.disconnect();
    }
    voices.delete(peerId);
  };

  /** Builds the spatial chain behind `source` (plus an analyser tap for a stream) and registers it. */
  const addVoice = (key: string, owner: string, source: AudioNode, input: VoiceInput) => {
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

    if (input.kind === 'stream') {
      source.connect(input.analyser);
    }
    source.connect(filter);
    filter.connect(dry);
    dry.connect(panner);
    panner.connect(ctx.destination);
    filter.connect(send);
    send.connect(reverb);

    voices.set(key, {
      input,
      owner,
      source,
      filter,
      dry,
      send,
      panner,
      dryTarget: restingAt(0),
      sendTarget: restingAt(0),
      panX: restingAt(0),
      panZ: restingAt(0),
      occluded: false,
      lastOcclusionAt: Number.NEGATIVE_INFINITY,
      occlusionChangedAt: Number.NEGATIVE_INFINITY,
      positioned: false,
      rms: 0,
      speaking: 0,
    });
  };

  /** The voice's RMS and speaking level from its analyser; synthesised sources have none. */
  const measure = (v: Voice, dt: number) => {
    if (v.input.kind !== 'stream') {
      return;
    }
    const { analyser, samples } = v.input;
    analyser.getFloatTimeDomainData(samples);
    v.rms = rootMeanSquare(samples);
    v.speaking = speakingLevel(v.speaking, v.rms, dt);
  };

  /** Muffles the voice behind a wall, checked every OCCLUSION_INTERVAL_MS. */
  const occlude = (v: Voice, now: number, t: number, listener: PlayerState, pos: Source) => {
    if (now - v.lastOcclusionAt < OCCLUSION_INTERVAL_MS) {
      return;
    }
    v.lastOcclusionAt = now;
    const occluded = !(pos.sees ?? hasLineOfSight(map, listener.x, listener.y, pos.x, pos.y));
    if (occluded !== v.occluded) {
      v.occluded = occluded;
      v.occlusionChangedAt = now;
      v.filter.frequency.setTargetAtTime(occluded ? settings.muffleHz : MUFFLE_OPEN_HZ, t, TAU_OCCLUSION);
    }
  };

  /** The voice's gains from its distance and occlusion, and its pan from where it is. */
  const place = (v: Voice, now: number, t: number, listener: PlayerState, pos: Source) => {
    // Each setTargetAtTime replaces the running curve, so keep the slow constant until it settles.
    const tau = now - v.occlusionChangedAt < OCCLUSION_SETTLE_MS ? TAU_OCCLUSION : TAU_POSITION;
    const g = voiceGains(Math.hypot(pos.x - listener.x, pos.y - listener.y), v.occluded, settings);
    glide(v.dry.gain, v.dryTarget, g.dry, t, tau);
    glide(v.send.gain, v.sendTarget, g.send, t, tau);
    const jump = !v.positioned;
    if (jump) {
      // Ear height, like the listener: set once.
      v.panner.positionY.setValueAtTime(0, t);
    }
    move(v.panner.positionX, v.panX, pos.x, t, jump);
    move(v.panner.positionZ, v.panZ, pos.y, t, jump);
    v.positioned = true;
  };

  return {
    attach(peerId, stream, owner = peerId) {
      const existing = voices.get(peerId);
      if (existing?.input.kind === 'stream' && existing.input.stream === stream) {
        return;
      }
      if (existing) {
        detach(peerId);
      }
      // createMediaStreamSource throws on a stream with no audio (a peer without a mic).
      if (stream.getAudioTracks().length === 0) {
        return;
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = ANALYSER_SIZE;
      addVoice(peerId, owner, ctx.createMediaStreamSource(stream), {
        kind: 'stream',
        stream,
        analyser,
        samples: new Float32Array(ANALYSER_SIZE),
      });
    },

    attachNode(key, node, owner = key) {
      if (voices.get(key)?.source === node) {
        return;
      }
      detach(key);
      addVoice(key, owner, node, { kind: 'node' });
    },

    detach,

    playUnplaced(node) {
      node.connect(ctx.destination);
    },

    update(now, listener, sources) {
      const t = ctx.currentTime;
      const dt = lastUpdate === null ? 0 : (now - lastUpdate) / 1000;
      lastUpdate = now;
      setListener(listener, t);

      for (const v of voices.values()) {
        measure(v, dt);
        const pos = sources.get(v.owner);
        if (!pos) {
          glide(v.dry.gain, v.dryTarget, 0, t, TAU_POSITION);
          glide(v.send.gain, v.sendTarget, 0, t, TAU_POSITION);
          continue;
        }
        occlude(v, now, t, listener, pos);
        place(v, now, t, listener, pos);
      }
    },

    speaking: (peerId) => voices.get(peerId)?.speaking ?? 0,
    inputLevel: (peerId) => voices.get(peerId)?.rms ?? 0,
    settings: () => settings,

    async resume() {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
    },

    dispose() {
      for (const id of [...voices.keys()]) {
        detach(id);
      }
      reverb.disconnect();
      reverbGain.disconnect();
    },
  };
}
