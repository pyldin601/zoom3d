// Spec §9.1 graph for one remote peer, plus §9.2 curves.
export const REF = 1.5;
export const MAX = 12;
const MUFFLE_OPEN = 16000;
const MUFFLE_CLOSED = 700;
const OCCLUDED_GAIN = 0.5;
const TAU_POSITION = 0.05;
const TAU_OCCLUSION = 0.15;

export function curves(d) {
  const n = Math.min(Math.max((d - REF) / (MAX - REF), 0), 1);
  return { dry: (1 - n) ** 2, send: (0.15 + 0.35 * n) * (1 - n ** 4) };
}

// Stereo decorrelated noise with exponential decay reaching -60 dB at `seconds`.
export function makeImpulse(ctx, seconds = 0.8, preDelay = 0.01) {
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

export function createSpatial(ctx, stream) {
  const source = ctx.createMediaStreamSource(stream);
  const muffle = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: MUFFLE_OPEN });
  const dry = new GainNode(ctx, { gain: 0 });
  const send = new GainNode(ctx, { gain: 0 });
  const panner = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0 });
  const convolver = new ConvolverNode(ctx, { buffer: makeImpulse(ctx) });
  const out = new GainNode(ctx);
  source.connect(muffle);
  muffle.connect(dry).connect(panner).connect(out);
  muffle.connect(send).connect(convolver).connect(out);

  let distance = 0;
  let occluded = false;
  let elementDest = null;

  function applyGains(tau) {
    const { dry: g, send: s } = curves(distance);
    const k = occluded ? OCCLUDED_GAIN : 1;
    dry.gain.setTargetAtTime(g * k, ctx.currentTime, tau);
    send.gain.setTargetAtTime(s * k, ctx.currentTime, tau);
  }

  return {
    // Listener at origin facing -z; (dx, dy) in tiles maps to (dx, 0, dy).
    setPosition(dx, dy) {
      distance = Math.hypot(dx, dy);
      panner.positionX.setTargetAtTime(dx, ctx.currentTime, TAU_POSITION);
      panner.positionZ.setTargetAtTime(dy, ctx.currentTime, TAU_POSITION);
      applyGains(TAU_POSITION);
    },
    setOccluded(on) {
      occluded = on;
      muffle.frequency.setTargetAtTime(on ? MUFFLE_CLOSED : MUFFLE_OPEN, ctx.currentTime, TAU_OCCLUSION);
      applyGains(TAU_OCCLUSION);
    },
    setPanningModel(model) {
      panner.panningModel = model;
    },
    // Returns the MediaStream to play in an <audio> element for 'webaudio-element', else null.
    // 'none' silences the graph (used by the baseline 'element' mode).
    connectTo(mode) {
      out.disconnect();
      if (mode === 'webaudio') out.connect(ctx.destination);
      if (mode !== 'webaudio-element') return null;
      elementDest ??= ctx.createMediaStreamDestination();
      out.connect(elementDest);
      return elementDest.stream;
    },
    dispose() {
      source.disconnect();
      out.disconnect();
    },
  };
}
