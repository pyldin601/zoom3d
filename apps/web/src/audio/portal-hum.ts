// The portal doorways' hum (portal glow spec §2.5): one per doorway in hearing range while the room's portals are on,
// settled by ear in the 2026-10-29 sketch. Each plays through the engine like the vacuum's hum, so it is placed, muffled
// and heard through portals like any other sound; its swell is the glow's own pulse, so sound and light never drift
// apart.
import type { Portals } from '@zoom3d/shared';
import type { AudioEngine } from './engine';

type Point = { readonly x: number; readonly y: number };

/** Master level, as low as the vacuum's (`VACUUM_GAIN`), so a doorway never covers a voice. Tuned by ear. */
export const HUM_GAIN = 0.04;

const ROOT_HZ = 98;
const ROOT_LEVEL = 0.2;
const FIFTH_HZ = 147;
const FIFTH_LEVEL = 0.25;
const TONE_CUTOFF_HZ = 1500;
const TONE_Q = 4;
const SWELL_TAU_S = 0.05;
/** Three time constants make the fade about 0.3 s, long enough that starting or stopping never clicks. */
const FADE_TAU_S = 0.1;
/** By six time constants a fading hum is at 0.25% of its level, so stopping it then is inaudible. */
const FADE_OUT_S = 6 * FADE_TAU_S;
/** Tiles in front of the doorway's plane: on its front side, but before the frame's faces. */
const SOURCE_OFFSET_TILES = 0.3;
/**
 * A hum starts within the engine's silent distance and stops this far past it, so pacing about the edge doesn't
 * restart it. Past that distance the engine's gain is already 0, so the fade out is silent.
 */
const HEARING_HYSTERESIS_TILES = 1;

/** Whether `listener` stands on the doorway's back side, or on its plane. */
function isBehind(portal: { cx: number; cy: number; nx: number; ny: number } | undefined, listener: Point): boolean {
  return portal !== undefined && (listener.x - portal.cx) * portal.nx + (listener.y - portal.cy) * portal.ny >= 0;
}

export function portalHumKey(index: number): string {
  return `portal-hum:${index}`;
}

export interface PortalHums {
  /**
   * Starts a doorway's hum when it comes within hearing range of `listener` (heard where `heard` places it, by
   * `portalHumKey`), fades it out when it leaves the range or portals turn off, and swells every hum by `pulse`.
   */
  sync(portals: Portals | null, pulse: number, listener: Point, heard: ReadonlyMap<string, Point>): void;
  /** Each hum's source point by `portalHumKey`, reusing `out`'s points; empties `out` while portals are off. */
  sourcesOf(portals: Portals | null, out: Map<string, { x: number; y: number }>): void;
  dispose(): void;
}

interface Hum {
  key: string;
  tones: OscillatorNode[];
  nodes: AudioNode[];
  swell: GainNode;
  output: GainNode;
}

export function createPortalHums(
  ctx: BaseAudioContext,
  engine: Pick<AudioEngine, 'attachNode' | 'detach' | 'settings'>
): PortalHums {
  const keys: string[] = [];
  const keyOf = (index: number) => {
    let key = keys.at(index);
    if (key === undefined) {
      key = portalHumKey(index);
      keys[index] = key;
    }
    return key;
  };
  let humming: Portals | null = null;
  /** Per portal index, its hum while it is in hearing range. */
  const hums: (Hum | null)[] = [];

  const tone = (type: OscillatorType, hz: number, level: number, into: AudioNode) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz;
    const gain = ctx.createGain();
    gain.gain.value = level;
    osc.connect(gain).connect(into);
    return { osc, gain };
  };

  const startHum = (key: string): Hum => {
    const now = ctx.currentTime;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = TONE_CUTOFF_HZ;
    filter.Q.value = TONE_Q;
    const root = tone('sine', ROOT_HZ, ROOT_LEVEL, filter);
    const fifth = tone('triangle', FIFTH_HZ, FIFTH_LEVEL, filter);
    const swell = ctx.createGain();
    const output = ctx.createGain();
    output.gain.setValueAtTime(0, now);
    output.gain.setTargetAtTime(HUM_GAIN, now, FADE_TAU_S);
    filter.connect(swell).connect(output);
    const tones = [root.osc, fifth.osc];
    for (const osc of tones) {
      osc.start(now);
    }
    engine.attachNode(key, output);
    return { key, tones, nodes: [root.gain, fifth.gain, filter, swell, output], swell, output };
  };

  const isHumming = (key: string) => hums.some((h) => h?.key === key);

  const fadeOut = (hum: Hum) => {
    const now = ctx.currentTime;
    hum.output.gain.cancelScheduledValues(now);
    hum.output.gain.setTargetAtTime(0, now, FADE_TAU_S);
    const [first] = hum.tones;
    if (first) {
      // Portals may be on again by now, with a new hum under the same key: that one stays attached.
      first.onended = () => {
        for (const node of hum.nodes) {
          node.disconnect();
        }
        if (!isHumming(hum.key)) {
          engine.detach(hum.key);
        }
      };
    }
    for (const osc of hum.tones) {
      osc.stop(now + FADE_OUT_S);
    }
  };

  const stopEveryHum = () => {
    for (let i = 0; i < hums.length; i++) {
      const hum = hums.at(i);
      if (hum) {
        hums[i] = null;
        fadeOut(hum);
      }
    }
    hums.length = 0;
  };

  const startOrStopByDistance = (portals: Portals, listener: Point, heard: ReadonlyMap<string, Point>) => {
    const silentTiles = engine.settings().max;
    for (let i = 0; i < portals.list.length; i++) {
      const key = keyOf(i);
      const source = heard.get(key);
      const tiles = source ? Math.hypot(source.x - listener.x, source.y - listener.y) : Number.POSITIVE_INFINITY;
      // From behind, a doorway is ordinary (D27): the user asked that it be silent there, like its glow.
      const behind = isBehind(portals.list.at(i), listener);
      const hum = hums.at(i) ?? null;
      if (hum === null && !behind && tiles < silentTiles) {
        hums[i] = startHum(key);
      } else if (hum !== null && (behind || tiles > silentTiles + HEARING_HYSTERESIS_TILES)) {
        hums[i] = null;
        fadeOut(hum);
      }
    }
  };

  return {
    sync(portals, pulse, listener, heard) {
      if (portals !== humming) {
        stopEveryHum();
        humming = portals;
      }
      if (portals !== null) {
        startOrStopByDistance(portals, listener, heard);
      }
      const now = ctx.currentTime;
      for (const hum of hums) {
        hum?.swell.gain.setTargetAtTime(pulse, now, SWELL_TAU_S);
      }
    },

    sourcesOf(portals, out) {
      if (portals === null || out.size !== portals.list.length) {
        out.clear();
      }
      if (portals === null) {
        return;
      }
      for (let i = 0; i < portals.list.length; i++) {
        const portal = portals.list.at(i);
        if (!portal) {
          continue;
        }
        const key = keyOf(i);
        let source = out.get(key);
        if (!source) {
          source = { x: 0, y: 0 };
          out.set(key, source);
        }
        source.x = portal.cx - SOURCE_OFFSET_TILES * portal.nx;
        source.y = portal.cy - SOURCE_OFFSET_TILES * portal.ny;
      }
    },

    dispose() {
      const now = ctx.currentTime;
      for (const hum of hums) {
        if (!hum) {
          continue;
        }
        for (const osc of hum.tones) {
          osc.stop(now);
        }
        for (const node of hum.nodes) {
          node.disconnect();
        }
        engine.detach(hum.key);
      }
      hums.length = 0;
      humming = null;
    },
  };
}
