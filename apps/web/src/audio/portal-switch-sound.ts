// The portal switch's three sounds (portal sequence spec §2.3): lights off, portals on, lights on. They are the building's
// power, so they play unplaced, the same level for everyone, each with its own reverb tail. Every value is the recipe
// the user approved by ear in the 2026-10-29 sketch.
import type { AudioEngine } from './engine';

/** Master level on top of the recipe's, so the loudest switch sound stays under a voice. Tuned by ear. */
export const SWITCH_SOUND_GAIN = 0.25;

/** Each sound's tail is its own, from the recipe; the room's short reverb on top would change what was approved. */
const ROOM_REVERB_SEND = 0;
/** As in the sketch: scheduling a moment ahead keeps the first ramps from being cut off. */
const START_AHEAD_S = 0.02;

const LIGHTS_OFF = {
  lengthS: 1.2,
  level: 0.8,
  tailS: 3.5,
  wet: 0.55,
  fromHz: 90,
  toHz: 32,
  thunkS: 0.4,
  thunkCutoffHz: 260,
  thunkLevel: 0.9,
  thunkFallS: 0.35,
};

const PORTALS_ON = {
  lengthS: 0.7,
  level: 0.45,
  tailS: 1.2,
  wet: 0.3,
  fromHz: 140,
  toHz: 520,
  toneLevel: 0.6,
  buzzHz: 100,
  buzzCutoffHz: 900,
  buzzLevel: 0.0875,
};

const LIGHTS_ON = {
  level: 0.5,
  tailS: 1.5,
  wet: 0.35,
  flickerSpanS: 0.3,
  clickS: 0.05,
  clickHz: 1600,
  clickQ: 2,
  clickLevel: 1.6,
  clickFallS: 0.04,
  flickers: 3,
  flickerLevelMin: 0.5,
  flickerLevelRange: 0.4,
  flickerJitterS: 0.02,
  humHz: 100,
  humCutoffHz: 700,
  humLevel: 0.045,
};

/** The quiet floor exponential ramps start from and fall to: they can't reach 0. */
const SILENT = 0.0001;
const FADED = 0.001;

export interface PortalSwitchSounds {
  lightsOff(): void;
  portalsOn(): void;
  lightsOn(): void;
}

/** Builds the reverb impulses and noise once, here, so a cue costs no more than its nodes. */
export function createPortalSwitchSounds(ctx: BaseAudioContext, engine: AudioEngine): PortalSwitchSounds {
  const impulses = {
    lightsOff: decayingNoise(ctx, LIGHTS_OFF.tailS),
    portalsOn: decayingNoise(ctx, PORTALS_ON.tailS),
    lightsOn: decayingNoise(ctx, LIGHTS_ON.tailS),
  };
  const thunkNoise = whiteNoise(ctx, LIGHTS_OFF.thunkS);
  const clickNoise = whiteNoise(ctx, LIGHTS_ON.clickS);

  /**
   * A sound's output: dry plus its own reverb, sent on to the engine. Every node goes in `nodes`, and all are
   * disconnected once the last source has stopped (`endS` after `t`) and the tail has died away.
   */
  const outputFor = (
    nodes: AudioNode[],
    t: number,
    endS: number,
    sound: { level: number; tailS: number; wet: number },
    impulse: AudioBuffer
  ) => {
    const out = ctx.createGain();
    out.gain.value = sound.level * SWITCH_SOUND_GAIN;
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse;
    const wet = ctx.createGain();
    wet.gain.value = sound.wet;
    const mix = ctx.createGain();
    out.connect(mix);
    out.connect(reverb).connect(wet).connect(mix);
    engine.playUnplaced(mix, ROOM_REVERB_SEND);
    nodes.push(out, reverb, wet, mix);
    const releaseInS = t + endS + sound.tailS - ctx.currentTime;
    setTimeout(() => {
      for (const node of nodes) {
        node.disconnect();
      }
    }, releaseInS * 1000);
    return out;
  };

  const lightsOff = () => {
    const s = LIGHTS_OFF;
    const t = ctx.currentTime + START_AHEAD_S;
    const nodes: AudioNode[] = [];
    const endS = s.lengthS + 0.05;
    const out = outputFor(nodes, t, endS, s, impulses.lightsOff);

    const body = ctx.createOscillator();
    body.frequency.setValueAtTime(s.fromHz, t);
    body.frequency.exponentialRampToValueAtTime(s.toHz, t + s.lengthS);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0, t);
    bodyGain.gain.linearRampToValueAtTime(1, t + 0.01);
    bodyGain.gain.exponentialRampToValueAtTime(FADED, t + s.lengthS);
    body.connect(bodyGain).connect(out);
    body.start(t);
    body.stop(t + endS);

    const thunk = ctx.createBufferSource();
    thunk.buffer = thunkNoise;
    const thunkFilter = lowpass(s.thunkCutoffHz);
    const thunkGain = ctx.createGain();
    thunkGain.gain.setValueAtTime(s.thunkLevel, t);
    thunkGain.gain.exponentialRampToValueAtTime(FADED, t + s.thunkFallS);
    thunk.connect(thunkFilter).connect(thunkGain).connect(out);
    thunk.start(t);
    thunk.stop(t + s.thunkS);
    nodes.push(body, bodyGain, thunk, thunkFilter, thunkGain);
  };

  const portalsOn = () => {
    const s = PORTALS_ON;
    const t = ctx.currentTime + START_AHEAD_S;
    const nodes: AudioNode[] = [];
    const out = outputFor(nodes, t, s.lengthS + 0.35, s, impulses.portalsOn);

    const tone = ctx.createOscillator();
    tone.frequency.setValueAtTime(s.fromHz, t);
    tone.frequency.exponentialRampToValueAtTime(s.toHz, t + s.lengthS);
    const toneGain = ctx.createGain();
    toneGain.gain.setValueAtTime(SILENT, t);
    toneGain.gain.exponentialRampToValueAtTime(s.toneLevel, t + s.lengthS * 0.6);
    toneGain.gain.exponentialRampToValueAtTime(FADED, t + s.lengthS + 0.25);
    tone.connect(toneGain).connect(out);
    tone.start(t);
    tone.stop(t + s.lengthS + 0.3);

    const buzz = ctx.createOscillator();
    buzz.type = 'sawtooth';
    buzz.frequency.value = s.buzzHz;
    const buzzFilter = lowpass(s.buzzCutoffHz);
    const buzzGain = ctx.createGain();
    buzzGain.gain.setValueAtTime(SILENT, t);
    buzzGain.gain.exponentialRampToValueAtTime(s.buzzLevel, t + s.lengthS * 0.7);
    buzzGain.gain.exponentialRampToValueAtTime(SILENT, t + s.lengthS + 0.3);
    buzz.connect(buzzFilter).connect(buzzGain).connect(out);
    buzz.start(t);
    buzz.stop(t + s.lengthS + 0.35);
    nodes.push(tone, toneGain, buzz, buzzFilter, buzzGain);
  };

  const lightsOn = () => {
    const s = LIGHTS_ON;
    const t = ctx.currentTime + START_AHEAD_S;
    const nodes: AudioNode[] = [];
    const out = outputFor(nodes, t, s.flickerSpanS + 1.3, s, impulses.lightsOn);

    const click = (at: number, level: number) => {
      const noise = ctx.createBufferSource();
      noise.buffer = clickNoise;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = s.clickHz;
      band.Q.value = s.clickQ;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(level, at);
      gain.gain.exponentialRampToValueAtTime(FADED, at + s.clickFallS);
      noise.connect(band).connect(gain).connect(out);
      noise.start(at);
      noise.stop(at + s.clickS);
      nodes.push(noise, band, gain);
    };
    click(t, s.clickLevel);
    for (let i = 1; i <= s.flickers; i++) {
      const evenlyAt = t + (s.flickerSpanS * i) / (s.flickers + 1);
      click(evenlyAt + Math.random() * s.flickerJitterS, s.flickerLevelMin + Math.random() * s.flickerLevelRange);
    }

    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = s.humHz;
    const humFilter = lowpass(s.humCutoffHz);
    const humGain = ctx.createGain();
    humGain.gain.setValueAtTime(SILENT, t);
    humGain.gain.exponentialRampToValueAtTime(s.humLevel, t + s.flickerSpanS + 0.1);
    humGain.gain.exponentialRampToValueAtTime(SILENT, t + s.flickerSpanS + 1.2);
    hum.connect(humFilter).connect(humGain).connect(out);
    hum.start(t);
    hum.stop(t + s.flickerSpanS + 1.3);
    nodes.push(hum, humFilter, humGain);
  };

  function lowpass(hz: number): BiquadFilterNode {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = hz;
    return filter;
  }

  return { lightsOff, portalsOn, lightsOn };
}

/**
 * Stereo noise falling as (1 − x)³ over `seconds`: the sketch's impulse, left to the convolver's own normalisation as
 * the sketch did, so the wet level is the one approved.
 */
function decayingNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }
  }
  return buffer;
}

function whiteNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}
