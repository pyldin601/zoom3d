import { LEVEL1, type PlayerState, parseMap } from '@zoom3d/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import { createFramebuffer, type Framebuffer } from '../framebuffer';
import { corridorLights } from '../lighting';
import { makeTextures } from '../textures';
import { REFLECTION_SAMPLE_OFFSET, REFLECTION_SCALE } from './buffers';
import { lastTracedBuffers, renderTraced, type TracedLighting } from './frame';
import { bakeRoom, pixelOf } from './test-helpers';
import { shownPixel } from './tone';
import { TRACED_MATERIALS, type TracedWorld } from './world';

const LEVEL = parseMap(LEVEL1);
const TEXTURES = makeTextures(1);
const WOOD = 2;
const BLUE = 3;

/**
 * Down the blue corridor x 33..35, with lamps ahead at (34.5, 36.5) and (34.5, 41.5). The plan's pose was a tile on, at
 * y 33, where the nearer lamp's mirror image in the floor is below the frame.
 */
const BLUE_CORRIDOR: PlayerState = { x: 34.5, y: 32.0, angle: Math.PI / 2 };
/**
 * In the wood room x 29..39, y 1..7, looking north-west at its far wall, lamps in the doorways behind. The plan's pose,
 * x 41.5, is inside the room's east wall.
 */
const WOOD_ROOM: PlayerState = { x: 38.5, y: 6.2, angle: -Math.PI / 2 - 0.5 };

function draw(fb: Framebuffer, eye: PlayerState, traced: TracedLighting): void {
  renderTraced(fb, { map: traced.world.map, eye, people: [], traced });
}

/** A reflection sample's linear rgb, from the last frame. */
function reflectedAt(sampleCol: number, sampleRow: number): [number, number, number] {
  const { reflected, reflectedWidth } = lastTracedBuffers();
  const at = (sampleRow * reflectedWidth + sampleCol) * 3;
  return [reflected.at(at) ?? 0, reflected.at(at + 1) ?? 0, reflected.at(at + 2) ?? 0];
}

function sum([red, green, blue]: readonly number[]): number {
  return (red ?? 0) + (green ?? 0) + (blue ?? 0);
}

/** The frame pixel a reflection sample was traced for. */
function framePixelOf(sampleCol: number, sampleRow: number): { col: number; row: number } {
  return {
    col: sampleCol * REFLECTION_SCALE + REFLECTION_SAMPLE_OFFSET,
    row: sampleRow * REFLECTION_SCALE + REFLECTION_SAMPLE_OFFSET,
  };
}

/** Each tile id's reflection colour: white, blended by its material's tint towards its average colour at full strength. */
function tintOf(world: TracedWorld, tile: number): [number, number, number] {
  const tint = TRACED_MATERIALS.at(tile)?.tint ?? 0;
  const mean = tile === 0 ? world.floorAlbedo : world.meanAlbedo.at(tile);
  const top = Math.max(...(mean ?? [1]));
  return [0, 1, 2].map((channel) => 1 - tint + (tint * (mean?.at(channel) ?? 0)) / top) as [number, number, number];
}

/** The tinted reflections on the wall pixels of `tile` in the last frame: one per reflection sample on such a wall. */
function wallReflections(world: TracedWorld, tile: number): [number, number, number][] {
  const { reflectedWidth, reflectedHeight, specTile, spec, wallStart, wallEnd, width } = lastTracedBuffers();
  const tint = tintOf(world, tile);
  const found: [number, number, number][] = [];
  for (let sampleRow = 0; sampleRow < reflectedHeight; sampleRow++) {
    for (let sampleCol = 0; sampleCol < reflectedWidth; sampleCol++) {
      const { col, row } = framePixelOf(sampleCol, sampleRow);
      const onWall = row >= (wallStart.at(col) ?? 0) && row < (wallEnd.at(col) ?? 0);
      const pixel = row * width + col;
      if (onWall && specTile.at(pixel) === tile && (spec.at(pixel) ?? 0) > 0) {
        const light = reflectedAt(sampleCol, sampleRow);
        found.push([light[0] * tint[0], light[1] * tint[1], light[2] * tint[2]]);
      }
    }
  }
  return found;
}

function brightest(lights: readonly [number, number, number][]): [number, number, number] {
  return lights.reduce((best, light) => (sum(light) > sum(best) ? light : best), [0, 0, 0]);
}

describe('reflections on LEVEL1', () => {
  let traced: TracedLighting;
  const fb = createFramebuffer();

  beforeAll(() => {
    traced = bakeRoom(LEVEL, TEXTURES, corridorLights(LEVEL));
  });

  test('are traced at 1/REFLECTION_SCALE of the frame each way', () => {
    draw(fb, BLUE_CORRIDOR, traced);
    const { reflected, reflectedWidth, reflectedHeight } = lastTracedBuffers();
    expect(reflectedWidth).toBe(Math.floor(fb.width / REFLECTION_SCALE));
    expect(reflectedHeight).toBe(Math.floor(fb.height / REFLECTION_SCALE));
    expect(reflected.length).toBe(reflectedWidth * reflectedHeight * 3);
  });

  describe("a lamp down the blue corridor makes one streak in the floor's reflection", () => {
    const nearerLamp = { x: 34.5, y: 36.5 };

    /** The reflection sample nearest the lamp's mirror image: a tile below the floor, as the lamp is a tile above it. */
    function imageSample(): { sampleCol: number; sampleRow: number } {
      const image = pixelOf(fb, BLUE_CORRIDOR, nearerLamp.x, nearerLamp.y, -1);
      expect(image.row).toBeLessThan(fb.height);
      return {
        sampleCol: Math.round((image.col - REFLECTION_SAMPLE_OFFSET) / REFLECTION_SCALE),
        sampleRow: Math.round((image.row - REFLECTION_SAMPLE_OFFSET) / REFLECTION_SCALE),
      };
    }

    // The floor is satin: off its bottom rows the cone reaches the ceiling about a tile wide and, stretched by 1 / slant
    // and 1 / rise, 9 to 11 tiles long. So the streak runs down the floor, brightest nearest the eye where the cone is
    // smallest, with no peak of its own at the image. What it must not have is a box blur's plateau or edges.
    test('down its column it brightens steadily towards the eye, through the image to the bottom of the frame', () => {
      draw(fb, BLUE_CORRIDOR, traced);
      const { sampleCol, sampleRow } = imageSample();
      const { reflectedHeight } = lastTracedBuffers();
      for (let row = sampleRow - 16; row < reflectedHeight - 1; row++) {
        const step = sum(reflectedAt(sampleCol, row + 1)) / sum(reflectedAt(sampleCol, row));
        expect(step, `from sample row ${row}`).toBeGreaterThan(1);
        expect(step, `from sample row ${row}`).toBeLessThan(1.1);
      }
      const [red, green, blue] = reflectedAt(sampleCol, sampleRow);
      const [lampRed = 0, lampGreen = 0, lampBlue = 0] = traced.world.lampRgb;
      expect(green / red).toBeCloseTo(lampGreen / lampRed, 1);
      expect(blue / red).toBeCloseTo(lampBlue / lampRed, 1);
    });

    test('across the image it falls off steadily for at least 3 samples each side, with no hard edge', () => {
      draw(fb, BLUE_CORRIDOR, traced);
      const { sampleCol, sampleRow } = imageSample();
      const across = (col: number) => sum(reflectedAt(col, sampleRow));
      const nearImage = [-3, -2, -1, 0, 1, 2, 3].map((offset) => sampleCol + offset);
      const middle = nearImage.reduce((best, col) => (across(col) > across(best) ? col : best));
      for (let offset = 0; offset < 3; offset++) {
        for (const side of [-1, 1]) {
          const from = across(middle + side * offset);
          const to = across(middle + side * (offset + 1));
          expect(to).toBeLessThan(from);
          // A hard edge drops by more than a few percent from one sample to the next this close to the middle.
          expect(to).toBeGreaterThan(from * 0.9);
        }
      }
    });
  });

  test('the brightest reflection on the far wood wall is golden: red, then green, then blue, more so than the lamp', () => {
    draw(fb, WOOD_ROOM, traced);
    const reflections = wallReflections(traced.world, WOOD);
    const [red, green, blue] = brightest(reflections);
    // It is a lamp's highlight, far brighter than what the wall mostly reflects.
    const sums = reflections.map(sum).sort((a, b) => a - b);
    expect(red + green + blue).toBeGreaterThan(100 * (sums.at(sums.length >> 1) ?? 0));
    const [lampRed = 0, lampGreen = 0, lampBlue = 0] = traced.world.lampRgb;
    expect(red).toBeGreaterThan(green);
    expect(green).toBeGreaterThan(blue);
    expect(blue).toBeGreaterThan(0);
    expect(green / red).toBeLessThan(lampGreen / lampRed);
    expect(blue / red).toBeLessThan(lampBlue / lampRed);
  });

  test('the blue corridor walls shine bluish: their reflections, and the brightest of them, have more blue than red', () => {
    draw(fb, BLUE_CORRIDOR, traced);
    const reflections = wallReflections(traced.world, BLUE);
    expect(reflections.length).toBeGreaterThan(1000);
    const totalRed = reflections.reduce((total, [red]) => total + red, 0);
    const totalBlue = reflections.reduce((total, [, , blue]) => total + blue, 0);
    expect(totalBlue).toBeGreaterThan(totalRed);
    const [red, , blue] = brightest(reflections);
    expect(blue).toBeGreaterThan(red);
  });

  test("a reflecting pixel is its light less its Fresnel share, plus that share of the reflection tinted by its surface's colour, blended up from the samples either side", () => {
    for (const eye of [BLUE_CORRIDOR, WOOD_ROOM]) {
      draw(fb, eye, traced);
      const { hdr, spec, specTile, reflected, reflectedWidth, reflectedHeight } = lastTracedBuffers();
      const sampleAt = (position: number, samples: number) => {
        const clamped = Math.min(samples - 1, Math.max(0, position));
        const before = Math.min(samples - 2, Math.floor(clamped));
        return { before, towardsNext: clamped - before };
      };
      let checked = 0;
      for (let row = 0; row < fb.height; row += 7) {
        const down = sampleAt((row - REFLECTION_SAMPLE_OFFSET) / REFLECTION_SCALE, reflectedHeight);
        for (let col = 0; col < fb.width; col += 5) {
          const pixel = row * fb.width + col;
          const weight = spec.at(pixel) ?? 0;
          if (weight <= 0) {
            continue;
          }
          checked++;
          const across = sampleAt((col - REFLECTION_SAMPLE_OFFSET) / REFLECTION_SCALE, reflectedWidth);
          const tint = tintOf(traced.world, specTile.at(pixel) ?? 0);
          const light = [0, 1, 2].map((channel) => {
            const at = (sampleRow: number, sampleCol: number) =>
              reflected.at((sampleRow * reflectedWidth + sampleCol) * 3 + channel) ?? 0;
            const blendRow = (sampleRow: number) =>
              at(sampleRow, across.before) +
              (at(sampleRow, across.before + 1) - at(sampleRow, across.before)) * across.towardsNext;
            const blended =
              blendRow(down.before) + (blendRow(down.before + 1) - blendRow(down.before)) * down.towardsNext;
            return (hdr.at(pixel * 3 + channel) ?? 0) * (1 - weight) + weight * (tint[channel] ?? 0) * blended;
          });
          const expected = shownPixel(light[0] ?? 0, light[1] ?? 0, light[2] ?? 0);
          const shown = fb.pixels.at(pixel) ?? 0;
          for (const shift of [0, 8, 16]) {
            const difference = Math.abs(((shown >>> shift) & 0xff) - ((expected >>> shift) & 0xff));
            if (difference > 1) {
              expect(difference, `pixel (${col}, ${row}), channel at bit ${shift}`).toBeLessThanOrEqual(1);
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
    }
  });
});

/** A lit hall with a closet walled off in its middle: nothing in the closet can see the hall or its lamps. */
const HALL_AND_CLOSET = parseMap(
  Array.from({ length: 22 }, (_, row) => {
    if (row === 0 || row === 21) {
      return '1'.repeat(22);
    }
    const closet = row === 7 || row === 11 ? '111111' : row === 9 ? '1.S..1' : '1....1';
    return row >= 7 && row <= 11 ? `1.......${closet}.......1` : `1${'.'.repeat(20)}1`;
  }).join('\n')
);
const HALL_LAMPS = [3.5, 11, 18.5]
  .flatMap((x) => [3.5, 11, 18.5].map((y) => ({ x, y })))
  .filter(({ x, y }) => x !== 11 || y !== 11);

describe('a sealed room without lamps', () => {
  /**
   * Its own light is none at all, and the soft copy of the hall's, averaged over half a tile either way, reaches a hair
   * across the wall: a few 1e-5. Seeing the hall would be a thousand times that.
   */
  const MOST_LEAKED = 1e-3;

  test('reflects next to nothing, however bright the hall behind its walls', () => {
    const traced = bakeRoom(HALL_AND_CLOSET, TEXTURES, HALL_LAMPS);
    const fb = createFramebuffer();
    const brightestReflected = () => lastTracedBuffers().reflected.reduce((most, light) => Math.max(most, light), 0);
    for (const angle of [0.3, 1.2, 2.5, -0.7, -2]) {
      draw(fb, { x: 10.5, y: 9.5, angle }, traced);
      expect(brightestReflected(), `facing ${angle}`).toBeLessThan(MOST_LEAKED);
    }
    draw(fb, { x: 3.5, y: 5, angle: 0.3 }, traced);
    expect(brightestReflected()).toBeGreaterThan(10 * MOST_LEAKED);
  });
});
