// The ball's voice (living ball spec §5): each emotion's FM sounds, as data the server can count and the client plays.
import type { BallCry } from '../../protocol/protocol';

/**
 * One FM note: a carrier gliding from `startHz` to `endHz`, modulated at `startHz × ratio`. A low ratio is a wobble
 * (its pitch wavers), one near 1 to 3 a bright or nasal voice, and a high `depth` makes either stronger.
 */
export interface BallCrySound {
  startHz: number;
  endHz: number;
  ratio: number;
  depth: number;
  durationS: number;
  peak: number;
}

const sound = (startHz: number, endHz: number, ratio: number, depth: number, durationS: number, peak: number) => ({
  startHz,
  endHz,
  ratio,
  depth,
  durationS,
  peak,
});

export const BALL_CRIES: Record<BallCry, readonly BallCrySound[]> = {
  // A long, breathy slide down, a sleepy creature stretching.
  yawn: [
    sound(420, 190, 0.5, 1.2, 0.9, 0.5),
    sound(520, 240, 0.012, 9, 1.1, 0.45),
    sound(360, 150, 1.5, 0.7, 0.8, 0.5),
    sound(610, 210, 0.5, 2, 1.2, 0.4),
    sound(300, 420, 0.02, 7, 0.7, 0.45),
  ],
  // Quick, bright upward chirps: tail wagging.
  happy: [
    sound(700, 1250, 2, 0.8, 0.14, 0.7),
    sound(880, 1500, 1, 1.1, 0.11, 0.7),
    sound(620, 1650, 3, 0.5, 0.18, 0.6),
    sound(990, 1320, 2.5, 0.9, 0.09, 0.75),
    sound(760, 1100, 0.04, 8, 0.24, 0.6),
  ],
  // A warm rise that settles: "oh, there's someone".
  relieved: [
    sound(330, 560, 1, 0.5, 0.5, 0.55),
    sound(280, 500, 0.5, 0.9, 0.65, 0.5),
    sound(410, 620, 2, 0.3, 0.4, 0.55),
    sound(350, 700, 0.02, 5, 0.55, 0.5),
    sound(250, 470, 1.5, 0.6, 0.7, 0.5),
  ],
  // Slow notes falling away.
  sad: [
    sound(560, 260, 1, 0.5, 0.7, 0.45),
    sound(480, 210, 0.015, 7, 0.9, 0.4),
    sound(640, 330, 0.5, 0.8, 0.6, 0.45),
    sound(420, 180, 2, 0.3, 1, 0.4),
    sound(700, 280, 0.01, 12, 0.8, 0.4),
  ],
  // Short and sharp, dropping fast: the only urgent sounds it has.
  yelp: [
    sound(1500, 600, 1.5, 1.6, 0.13, 0.85),
    sound(1850, 720, 2, 1.2, 0.1, 0.8),
    sound(1250, 480, 3, 1, 0.16, 0.85),
    sound(2100, 900, 1, 2, 0.09, 0.8),
    sound(1650, 520, 0.7, 2.4, 0.14, 0.85),
  ],
  // A fast warble: a modulator that is audibly a wobble.
  giggle: [
    sound(900, 1150, 0.018, 16, 0.32, 0.55),
    sound(1100, 950, 0.016, 22, 0.28, 0.55),
    sound(780, 1300, 0.024, 12, 0.36, 0.5),
    sound(1250, 1450, 0.012, 30, 0.25, 0.5),
    sound(1000, 800, 0.02, 18, 0.4, 0.5),
  ],
  // Thin, wavering and falling.
  whimper: [
    sound(980, 620, 0.008, 22, 0.75, 0.35),
    sound(840, 540, 0.01, 18, 0.9, 0.35),
    sound(1150, 760, 0.006, 32, 0.6, 0.3),
    sound(720, 610, 0.012, 14, 1, 0.3),
    sound(1050, 500, 0.009, 26, 0.85, 0.3),
  ],
  // A tiny blip.
  yip: [
    sound(1300, 1700, 1, 0.8, 0.07, 0.65),
    sound(1600, 1250, 2, 0.6, 0.06, 0.65),
    sound(1100, 1900, 1.5, 0.7, 0.08, 0.6),
    sound(1850, 2100, 3, 0.4, 0.05, 0.65),
    sound(1450, 1100, 0.5, 1.2, 0.07, 0.6),
  ],
  // A sudden leap up in pitch: "whoa!".
  startled: [
    sound(520, 1600, 2, 1.1, 0.16, 0.7),
    sound(420, 1900, 1.5, 1.6, 0.13, 0.7),
    sound(650, 1350, 3, 0.8, 0.2, 0.65),
    sound(380, 1500, 0.03, 12, 0.18, 0.65),
    sound(780, 2200, 1, 1.4, 0.12, 0.7),
  ],
};
