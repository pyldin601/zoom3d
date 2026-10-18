import { type GameMap, LEVEL1, type PlayerState, parseMap, tileAt } from '@zoom3d/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import { FACE_SIZE } from '../../media/faces';
import { EYE_HEIGHT } from '../camera';
import { createFramebuffer, type Framebuffer, rgb } from '../framebuffer';
import { corridorLights } from '../lighting';
import { AVATAR_RADIUS, FACE_RADIUS, type Sprite } from '../sprites';
import { makeTextures } from '../textures';
import { REFLECTION_SAMPLE_OFFSET, REFLECTION_SCALE } from './buffers';
import { lastTracedBuffers, renderTraced, type TracedLighting } from './frame';
import { createLightmaps } from './lightmaps';
import { FACE_REFLECTION_GAIN } from './people';
import { blurReflectedSurfaces, FLOOR_SURFACE, NO_SURFACE, TENT_PER_DEVIATION, wallSurface } from './surface-blur';
import { bakeRoom, drawOverNaN, expectEveryPixelWritten, pixelOf } from './test-helpers';
import { shownPixel } from './tone';
import { FACE_SOUTH, linearOfSrgbChannel, TRACED_MATERIALS, type TracedWorld } from './world';

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

function draw(fb: Framebuffer, eye: PlayerState, traced: TracedLighting, people: readonly Sprite[] = []): void {
  renderTraced(fb, { map: traced.world.map, eye, people, traced });
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

/** The reflection sample nearest the frame pixel that shows the point (x, y) at height z (0 floor .. 1 ceiling). */
function sampleShowing(
  fb: Framebuffer,
  eye: PlayerState,
  x: number,
  y: number,
  z: number
): { sampleCol: number; sampleRow: number } {
  const { col, row } = pixelOf(fb, eye, x, y, z);
  return {
    sampleCol: Math.round((col - REFLECTION_SAMPLE_OFFSET) / REFLECTION_SCALE),
    sampleRow: Math.round((row - REFLECTION_SAMPLE_OFFSET) / REFLECTION_SCALE),
  };
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

/** A person standing still at (x, y): `face` inside a ring of colour `ring`, or a flat disc of it when `face` is null. */
function personAt(x: number, y: number, ring: number, face: Uint32Array | null): Sprite {
  return {
    key: `${x}, ${y}`,
    x,
    y,
    color: ring,
    face,
    speaking: 0,
    bob: 0,
    itemBob: 0,
    sip: 0,
    cheers: 0,
    wobble: 0,
    held: null,
    boombox: false,
  };
}

/** `count` people at seeded points anywhere open on `map`, each its own colour, every other one with `face`. */
function crowdOver(map: GameMap, count: number, face: Uint32Array): Sprite[] {
  let seed = 3;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const people: Sprite[] = [];
  while (people.length < count) {
    const x = next() * map.width;
    const y = next() * map.height;
    if (tileAt(map, Math.floor(x), Math.floor(y)) === 0) {
      const ring = rgb(next() * 255, next() * 255, next() * 255);
      people.push(personAt(x, y, ring, people.length % 2 === 0 ? face : null));
    }
  }
  return people;
}

/** A packed colour as a person's disc shows it in a reflection: its linear light times FACE_REFLECTION_GAIN. */
function shownInReflection(packed: number): number[] {
  return [packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff].map(
    (byte) => linearOfSrgbChannel(byte) * FACE_REFLECTION_GAIN
  );
}

/**
 * How far `light` is blended from `behind` towards `colour` (the least-squares weight over the three channels), and the
 * most any channel misses that blend by.
 */
function blendOf(
  behind: readonly number[],
  light: readonly number[],
  colour: readonly number[]
): { weight: number; misfit: number } {
  const towards = colour.map((channel, at) => channel - (behind.at(at) ?? 0));
  const moved = light.map((channel, at) => channel - (behind.at(at) ?? 0));
  const weight =
    towards.reduce((total, step, at) => total + step * (moved.at(at) ?? 0), 0) /
    towards.reduce((total, step) => total + step * step, 0);
  const misfit = Math.max(...moved.map((step, at) => Math.abs(step - weight * (towards.at(at) ?? 0))));
  return { weight, misfit };
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
      expect(pixelOf(fb, BLUE_CORRIDOR, nearerLamp.x, nearerLamp.y, -1).row).toBeLessThan(fb.height);
      return sampleShowing(fb, BLUE_CORRIDOR, nearerLamp.x, nearerLamp.y, -1);
    }

    /**
     * Measured before the cone took mirror geometry (2026-10-17), when it was stretched by 1 / slant up the screen: the
     * light over the 9 sample rows round the image down its column, and the samples its row took to fall to half.
     */
    const STRETCHED_CONE = { lightRoundImage: 1.024, samplesToHalf: 40 };

    test('the image reads as a reflection: 5 times the light round it that the stretched cone gave, and narrower', () => {
      draw(fb, BLUE_CORRIDOR, traced);
      const { sampleCol, sampleRow } = imageSample();
      let lightRoundImage = 0;
      for (let row = sampleRow - 4; row <= sampleRow + 4; row++) {
        lightRoundImage += sum(reflectedAt(sampleCol, row));
      }
      expect(lightRoundImage).toBeGreaterThan(5 * STRETCHED_CONE.lightRoundImage);
      const middle = sum(reflectedAt(sampleCol, sampleRow));
      for (const side of [-1, 1]) {
        let samplesToHalf = 1;
        while (
          samplesToHalf < STRETCHED_CONE.samplesToHalf &&
          sum(reflectedAt(sampleCol + side * samplesToHalf, sampleRow)) > middle / 2
        ) {
          samplesToHalf++;
        }
        expect(samplesToHalf, `to the ${side < 0 ? 'left' : 'right'}`).toBeLessThan(STRETCHED_CONE.samplesToHalf);
      }
    });

    // The floor is satin: off its bottom rows the cone reaches the ceiling about a tile wide. Narrowed across the view by
    // the slant it is 0.36 tiles wide there; it keeps its width up the view, which the low rise stretches to 3 to 3.5
    // tiles along the ray. So the streak runs down the floor, brightest nearest the eye where the cone is smallest, with
    // no peak of its own at the image. What it must not have is a box blur's plateau or edges.
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

  describe("a lamp just past a doorway's wall faces (owner's review, 2026-10-18)", () => {
    /** The owner's view: the lamp 10.8 tiles ahead, just past the faces (10.3 to 10.6 tiles) of the doorway before it. */
    const AT_THE_DOORWAY: PlayerState = { x: 34.61952393867534, y: 20.65799239823415, angle: 1.5949999999999713 };
    const LAMP = { x: 34.5, y: 31.5 };
    /** A sample row its streak runs down, and the streak's red there at its brightest while walls hid it per column. */
    const BAR_ROW = 160;
    const HARD_EDGED_PEAK = 0.141;

    test("its streak on the floor fades out past the doorway's edges instead of stopping there, and still shows through", () => {
      draw(fb, AT_THE_DOORWAY, traced);
      const middle = sampleShowing(fb, AT_THE_DOORWAY, LAMP.x, LAMP.y, -1).sampleCol;
      const reds = Array.from({ length: 81 }, (_, offset) => reflectedAt(middle - 40 + offset, BAR_ROW)[0]);
      const peak = Math.max(...reds);
      for (let at = 1; at < reds.length; at++) {
        const step = Math.abs((reds.at(at) ?? 0) - (reds.at(at - 1) ?? 0));
        expect(step, `sample column ${middle - 40 + at}`).toBeLessThanOrEqual(0.25 * peak);
      }
      expect(reds.at(40)).toBeGreaterThanOrEqual(0.7 * HARD_EDGED_PEAK);
      // Beside the doorway, where it used to stop dead, some of it shows.
      expect(reds.at(40 - 13)).toBeGreaterThan(0);
      expect(reds.at(40 + 13)).toBeGreaterThan(0);
    });
  });

  describe("reflected surfaces are blurred by the same cone as the lamps (owner's review, 2026-10-18)", () => {
    const AT_THE_DOORWAY: PlayerState = { x: 34.61952393867534, y: 20.65799239823415, angle: 1.5949999999999713 };
    /**
     * The doorway 10.3 to 11.3 tiles ahead has a side wall either side, between 11 and 22 tiles deep. Before surfaces
     * were blurred, the floor mirrored each one's edge from one sample column to the next: these were the largest steps
     * between neighbouring samples across each edge in the walls' reflection, down the floor below them (the lit jamb
     * showed as a line).
     */
    const CRISP_STEPS = [0.0547, 0.0453];

    /** The reflection columns where the wall's distance jumps from the doorway's (< 12) to its sides' (> 20). */
    function doorwaySideEdges(): number[] {
      const { reflectedWidth, wallDistance } = lastTracedBuffers();
      const depthOf = (sampleCol: number) => wallDistance.at(framePixelOf(sampleCol, 0).col) ?? 0;
      const edges: number[] = [];
      for (let sampleCol = 0; sampleCol + 1 < reflectedWidth; sampleCol++) {
        const [nearer, further] = [depthOf(sampleCol), depthOf(sampleCol + 1)].sort((a, b) => a - b);
        if ((nearer ?? 0) < 12 && (further ?? 0) > 20) {
          edges.push(sampleCol);
        }
      }
      return edges;
    }

    test("the satin floor mirrors a doorway side wall's edge over several samples: its largest step a third of the crisp one", () => {
      // The walls' reflection alone: the lit room's less the lamps' (drawn with the room unlit).
      draw(fb, AT_THE_DOORWAY, { world: traced.world, maps: createLightmaps(traced.world) });
      const lampsAlone = Float32Array.from(lastTracedBuffers().reflected);
      draw(fb, AT_THE_DOORWAY, traced);
      const { reflected, reflectedWidth, reflectedHeight, wallEnd } = lastTracedBuffers();
      const wallsAt = (sampleCol: number, sampleRow: number) => {
        const at = (sampleRow * reflectedWidth + sampleCol) * 3;
        return [at, at + 1, at + 2].reduce((total, channel) => {
          return total + (reflected.at(channel) ?? 0) - (lampsAlone.at(channel) ?? 0);
        }, 0);
      };
      const edges = doorwaySideEdges();
      expect(edges.length).toBe(CRISP_STEPS.length);
      for (const [index, edge] of edges.entries()) {
        const wallFoot = Math.max(
          ...[edge - 3, edge + 4].map((sampleCol) => wallEnd.at(framePixelOf(sampleCol, 0).col) ?? 0)
        );
        // Right under the wall's foot the cone off the floor has hardly spread (under a sample there), as a reflection
        // is sharp where what it shows stands on the mirror: the steps are taken from the next row down.
        const floorRowBelowFoot = Math.ceil((wallFoot - REFLECTION_SAMPLE_OFFSET) / REFLECTION_SCALE) + 1;
        let largestStep = 0;
        for (let sampleRow = floorRowBelowFoot; sampleRow < reflectedHeight; sampleRow++) {
          for (let sampleCol = edge - 3; sampleCol <= edge + 3; sampleCol++) {
            const step = Math.abs(wallsAt(sampleCol + 1, sampleRow) - wallsAt(sampleCol, sampleRow));
            largestStep = Math.max(largestStep, step);
          }
        }
        expect(largestStep, `the edge at sample column ${edge}`).toBeLessThanOrEqual((CRISP_STEPS.at(index) ?? 0) / 3);
      }
    });

    test('the lamps are laid over the blurred surfaces as traced, not blurred again: unlit, the reflection is theirs alone', () => {
      draw(fb, AT_THE_DOORWAY, traced);
      const lit = lastTracedBuffers();
      const { reflected, reflectedSurface, blurredSurface, reflectedKeep, reflectedOver, surfaceKind } = lit;
      const lampsOverLitRoom = Float32Array.from(reflectedOver);
      // Every sample off a surface is what the people leave of it blurred, plus the lamps and people over it.
      let composed = 0;
      for (let at = 0; at < reflected.length; at += 97) {
        const sample = Math.floor(at / 3);
        if (surfaceKind.at(sample) === NO_SURFACE) {
          continue;
        }
        composed++;
        const keeps = reflectedKeep.at(sample) ?? 0;
        const expected = keeps * (blurredSurface.at(at) ?? 0) + (reflectedOver.at(at) ?? 0);
        expect(reflected.at(at), `sample value ${at}`).toBeCloseTo(expected, 6);
      }
      expect(composed).toBeGreaterThan(1000);
      expect(reflectedSurface.some((light) => light > 0)).toBe(true);

      const unlit: TracedLighting = { world: traced.world, maps: createLightmaps(traced.world) };
      draw(fb, AT_THE_DOORWAY, unlit);
      const lampsAlone = lastTracedBuffers();
      expect(lampsAlone.reflectedSurface.every((light) => light === 0)).toBe(true);
      expect(lampsAlone.reflected.reduce((most, light) => Math.max(most, light), 0)).toBeGreaterThan(0.1);
      const offASurface = Array.from(lampsAlone.reflected.keys()).filter(
        (at) => lampsAlone.surfaceKind.at(Math.floor(at / 3)) !== NO_SURFACE
      );
      const differing = offASurface.filter((at) => lampsAlone.reflected.at(at) !== lampsOverLitRoom.at(at));
      expect(offASurface.length).toBeGreaterThan(100_000);
      expect(differing, 'sample values where the lamps alone differ from the lamps over the lit room').toEqual([]);
    });

    test("no floor or wall reflection takes in another surface's, nor anything from the ceiling rows", () => {
      const isFloor = (kind: number) => kind === FLOOR_SURFACE;
      const isWall = (kind: number) => kind !== FLOOR_SURFACE && kind !== NO_SURFACE;
      for (const eye of [AT_THE_DOORWAY, BLUE_CORRIDOR, WOOD_ROOM]) {
        draw(fb, eye, traced);
        const buffers = lastTracedBuffers();
        const { reflectedSurface, surfaceKind } = buffers;
        const unblurred = Float32Array.from(reflectedSurface);
        const blurred = Float32Array.from(buffers.blurredSurface);
        for (const [name, kept] of [
          ['floor', isFloor],
          ['wall', isWall],
        ] as const) {
          // Every other sample turned blinding white, then all blurred again: the kept ones must not notice.
          for (const [sample, kind] of surfaceKind.entries()) {
            if (!kept(kind)) {
              reflectedSurface.fill(1000, sample * 3, sample * 3 + 3);
            }
          }
          blurReflectedSurfaces(buffers);
          let checked = 0;
          for (const [sample, kind] of surfaceKind.entries()) {
            if (!kept(kind)) {
              continue;
            }
            checked++;
            for (let at = sample * 3; at < sample * 3 + 3; at++) {
              const change = Math.abs((buffers.blurredSurface.at(at) ?? 0) - (blurred.at(at) ?? 0));
              if (change > 1e-6) {
                expect(change, `${name} sample ${sample}`).toBeLessThanOrEqual(1e-6);
              }
            }
          }
          expect(checked, name).toBeGreaterThan(1000);
          reflectedSurface.set(unblurred);
        }
      }
    });
  });

  test("crossing a doorway's edge, a lamp's streak on the floor changes by no more than 4% beyond its own slope", () => {
    draw(fb, BLUE_CORRIDOR, traced);
    const { sampleRow } = sampleShowing(fb, BLUE_CORRIDOR, 34.5, 36.5, -1);
    const across = (sampleCol: number) => sum(reflectedAt(sampleCol, sampleRow));
    const { wallStart } = lastTracedBuffers();
    const wallTopOf = (sampleCol: number) => wallStart.at(framePixelOf(sampleCol, 0).col) ?? 0;
    // The doorway at the corridor's end (11 tiles ahead, 24 through it) has its edges between these sample columns.
    for (const [before, after] of [
      [149, 150],
      [169, 170],
    ] as const) {
      expect(Math.abs(wallTopOf(after) - wallTopOf(before)), `walls at ${before}/${after}`).toBeGreaterThan(5);
      const step = across(after) - across(before);
      const ownSlope = (across(before) - across(before - 1) + across(after + 1) - across(after)) / 2;
      const excess = Math.abs(step - ownSlope) / Math.max(across(before), across(after));
      expect(excess, `from sample column ${before} to ${after}`).toBeLessThanOrEqual(0.04);
    }
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

  describe('people', () => {
    const GREEN_RING = rgb(40, 220, 60);
    const RED = rgb(230, 40, 30);
    const BLUE = rgb(30, 60, 230);
    /** A camera face of one colour throughout, far from the ring's. */
    const BLUE_FACE = new Uint32Array(FACE_SIZE * FACE_SIZE).fill(BLUE);

    /**
     * In the wood room, x 29..39 and y 1..7, a person 0.4 tiles out from the north wall's face at y 1, and the eye
     * looking at their mirror image 49° from face-on: the cone off the wood, 0.1225 tiles wide a tile out, is 0.075 tiles
     * wide when it reaches them, under 0.3 of their radius.
     */
    const BY_THE_WOOD_WALL = { x: 34, y: 1.4 };
    const IMAGE_IN_THE_WALL = { x: 34, y: 0.6 };
    const ASLANT_TO_THE_WALL: PlayerState = {
      x: 31,
      y: 3.2,
      angle: Math.atan2(IMAGE_IN_THE_WALL.y - 3.2, IMAGE_IN_THE_WALL.x - 31),
    };

    test('a person between the eye and a wood wall, seen aslant, shows sharp in its reflection: face, then ring', () => {
      draw(fb, ASLANT_TO_THE_WALL, traced, [personAt(BY_THE_WOOD_WALL.x, BY_THE_WOOD_WALL.y, GREEN_RING, BLUE_FACE)]);
      const { x, y } = IMAGE_IN_THE_WALL;
      const centre = sampleShowing(fb, ASLANT_TO_THE_WALL, x, y, EYE_HEIGHT);
      const ringMiddle = EYE_HEIGHT + ((1 + FACE_RADIUS) / 2) * AVATAR_RADIUS;
      const onRing = sampleShowing(fb, ASLANT_TO_THE_WALL, x, y, ringMiddle);
      const face = reflectedAt(centre.sampleCol, centre.sampleRow);
      const ring = reflectedAt(onRing.sampleCol, onRing.sampleRow);
      for (const [channel, shown] of shownInReflection(BLUE).entries()) {
        expect(face.at(channel), `the face, channel ${channel}`).toBeCloseTo(shown, 5);
      }
      for (const [channel, shown] of shownInReflection(GREEN_RING).entries()) {
        expect(ring.at(channel), `the ring, channel ${channel}`).toBeCloseTo(shown, 5);
      }
    });

    test("a sharp reflection shows a face mirrored, as a mirror does: the face's left half on the image's right", () => {
      const halves = new Uint32Array(FACE_SIZE * FACE_SIZE).map((_, texel) =>
        texel % FACE_SIZE < FACE_SIZE / 2 ? RED : BLUE
      );
      const eye = ASLANT_TO_THE_WALL;
      draw(fb, eye, traced, [personAt(BY_THE_WOOD_WALL.x, BY_THE_WOOD_WALL.y, GREEN_RING, halves)]);
      const { x, y } = IMAGE_IN_THE_WALL;
      const toImage = Math.hypot(x - eye.x, y - eye.y);
      // On the y-down map, (-y, x) of a direction is to its right.
      const rightX = -(y - eye.y) / toImage;
      const rightY = (x - eye.x) / toImage;
      const halfwayOut = (FACE_RADIUS * AVATAR_RADIUS) / 2;
      const onRight = sampleShowing(fb, eye, x + rightX * halfwayOut, y + rightY * halfwayOut, EYE_HEIGHT);
      const onLeft = sampleShowing(fb, eye, x - rightX * halfwayOut, y - rightY * halfwayOut, EYE_HEIGHT);
      const [rightRed, , rightBlue] = reflectedAt(onRight.sampleCol, onRight.sampleRow);
      const [leftRed, , leftBlue] = reflectedAt(onLeft.sampleCol, onLeft.sampleRow);
      expect(rightRed).toBeGreaterThan(10 * rightBlue);
      expect(leftBlue).toBeGreaterThan(10 * leftRed);
    });

    /** In the wood room, the eye 3.5 tiles west of a person, both on y 4, looking at them across the floor. */
    const FACING_EAST: PlayerState = { x: 30.5, y: 4, angle: 0 };
    const ACROSS_THE_FLOOR = { x: 34, y: 4 };

    test.each([
      ["the face's average", BLUE_FACE, BLUE],
      ['the ring colour, with no face', null, GREEN_RING],
    ])("on the rough floor a person's reflection is a soft blob of %s, laid over what is behind", (_, face, colour) => {
      draw(fb, FACING_EAST, traced);
      const behind = Float32Array.from(lastTracedBuffers().reflected);
      draw(fb, FACING_EAST, traced, [personAt(ACROSS_THE_FLOOR.x, ACROSS_THE_FLOOR.y, GREEN_RING, face)]);
      const image = sampleShowing(fb, FACING_EAST, ACROSS_THE_FLOOR.x, ACROSS_THE_FLOOR.y, -EYE_HEIGHT);
      const blob = shownInReflection(colour);
      const { reflectedWidth } = lastTracedBuffers();
      let strongest = 0;
      for (let sampleRow = image.sampleRow - 8; sampleRow <= image.sampleRow + 8; sampleRow++) {
        for (let sampleCol = image.sampleCol - 8; sampleCol <= image.sampleCol + 8; sampleCol++) {
          const at = (sampleRow * reflectedWidth + sampleCol) * 3;
          const { weight, misfit } = blendOf(
            Array.from(behind.subarray(at, at + 3)),
            reflectedAt(sampleCol, sampleRow),
            blob
          );
          expect(misfit, `sample (${sampleCol}, ${sampleRow})`).toBeLessThan(1e-6);
          expect(weight, `sample (${sampleCol}, ${sampleRow})`).toBeLessThan(1);
          strongest = Math.max(strongest, weight);
        }
      }
      expect(strongest).toBeGreaterThan(0.01);
    });

    test('among 100 people spread over the map, a frame writes every pixel, and a person 2 tiles ahead still reflects', () => {
      const crowd = crowdOver(LEVEL, 100, BLUE_FACE);
      const ahead = personAt(FACING_EAST.x + 2, FACING_EAST.y, GREEN_RING, null);
      drawOverNaN(fb, FACING_EAST, traced, crowd);
      expectEveryPixelWritten(fb);
      const crowdAlone = Float32Array.from(lastTracedBuffers().reflected);
      drawOverNaN(fb, FACING_EAST, traced, [...crowd, ahead]);
      expectEveryPixelWritten(fb);
      const change = [0, 0, 0];
      for (const [at, light] of lastTracedBuffers().reflected.entries()) {
        change[at % 3] = (change.at(at % 3) ?? 0) + light - (crowdAlone.at(at) ?? 0);
      }
      const [red = 0, green = 0, blue = 0] = change;
      expect(green).toBeGreaterThan(10);
      expect(green).toBeGreaterThan(4 * Math.max(red, blue));
    });
  });
});

/** A stone hall 14 tiles square, the eye at its west side looking east at the far wall, a lamp ahead of it. */
const STONE_HALL = parseMap(
  [
    '1'.repeat(16),
    ...Array.from({ length: 14 }, (_, row) => `1${row === 7 ? 'S' : '.'}${'.'.repeat(13)}1`),
    '1'.repeat(16),
  ].join('\n')
);

describe('a lamp beside the ray off a rough wall', () => {
  const EYE: PlayerState = { x: 3.5, y: 8.5, angle: 0 };

  test('fades out as it passes the culling margin, changing the centre column by no step as big as a tenth of it', () => {
    const traced = bakeRoom(STONE_HALL, TEXTURES, [{ x: 12, y: 8.5 }]);
    const fb = createFramebuffer();
    /** The centre column's light, as the lamp's disc (moved after the bake, so only its own reflection changes) is. */
    const centreColumnWithLampAt = (side: number): number => {
      traced.world.lampY[0] = EYE.y + side;
      draw(fb, EYE, traced);
      const { reflected, reflectedWidth, reflectedHeight } = lastTracedBuffers();
      let total = 0;
      for (let sampleRow = 0; sampleRow < reflectedHeight; sampleRow++) {
        const at = (sampleRow * reflectedWidth + (reflectedWidth >> 1)) * 3;
        total += (reflected.at(at) ?? 0) + (reflected.at(at + 1) ?? 0) + (reflected.at(at + 2) ?? 0);
      }
      return total;
    };
    // The stone's cone is 0.72 a tile wide, so the margin (2 tiles past the lamp's radius) is what cuts the lamp.
    const sides = Array.from({ length: 61 }, (_, step) => 1.9 + step * 0.01);
    const lights = sides.map(centreColumnWithLampAt);
    const lampsShare = (lights.at(0) ?? 0) - (lights.at(-1) ?? 0);
    expect(lampsShare).toBeGreaterThan(0.005);
    const biggestStep = Math.max(...lights.slice(1).map((light, at) => Math.abs(light - (lights.at(at) ?? 0))));
    expect(biggestStep).toBeLessThan(lampsShare / 10);
  });
});

describe('the ceiling above a wall in the reflections', () => {
  test("holds the wall's first sample, so the wall's top pixel row is not blended with black", () => {
    const traced = bakeRoom(STONE_HALL, TEXTURES, [{ x: 12, y: 8.5 }]);
    const fb = createFramebuffer();
    draw(fb, { x: 3.5, y: 8.5, angle: 0.2 }, traced);
    const { wallStart, reflectedWidth, reflectedHeight } = lastTracedBuffers();
    let checked = 0;
    for (let sampleCol = 0; sampleCol < reflectedWidth; sampleCol++) {
      const wallTop = Math.ceil(
        ((wallStart.at(framePixelOf(sampleCol, 0).col) ?? 0) - REFLECTION_SAMPLE_OFFSET) / REFLECTION_SCALE
      );
      if (wallTop < 1 || wallTop >= reflectedHeight) {
        continue;
      }
      checked++;
      const firstWallSample = reflectedAt(sampleCol, wallTop);
      expect(sum(firstWallSample), `column ${sampleCol}`).toBeGreaterThan(0);
      for (let sampleRow = 0; sampleRow < wallTop; sampleRow++) {
        expect(reflectedAt(sampleCol, sampleRow), `sample (${sampleCol}, ${sampleRow})`).toEqual(firstWallSample);
      }
    }
    expect(checked).toBeGreaterThan(reflectedWidth / 2);
  });
});

/** A wood room with a stone block standing against its north wall, x 6..7, y 1..2. */
const BLOCK_BY_THE_WOOD = parseMap(
  [
    '2'.repeat(16),
    ...Array.from(
      { length: 6 },
      (_, row) => `2${row === 0 ? '.....1' : row === 4 ? '.S....' : '......'}${'.'.repeat(8)}2`
    ),
    '2'.repeat(16),
  ].join('\n')
);

describe('glossy wood reflecting a stone block that stands against it', () => {
  /**
   * The cone's width in samples is its width over the depth its reflection shows at, so it is narrow where what the
   * wall reflects stands close to the wall, not where the wall is close to the eye: here near the block's foot, at
   * the corner, seen from 4 tiles off, aslant.
   */
  const EYE: PlayerState = { x: 1.5, y: 2.5, angle: Math.atan2(1 - 2.5, 5.7 - 1.5) };
  const NORTH_WALL = wallSurface(FACE_SOUTH, 0);
  /** Narrower than this (a deviation, in samples) both ways, a cone leaves a sample all but as traced. */
  const NARROW_CONE = 0.5;

  test('keeps its edges at most about 2 samples wide where the cone has spread under half a sample', () => {
    const traced = bakeRoom(BLOCK_BY_THE_WOOD, TEXTURES, [{ x: 4.5, y: 2.5 }]);
    const fb = createFramebuffer();
    draw(fb, EYE, traced);
    const { reflectedWidth, reflectedSurface, blurredSurface, surfaceKind, tentAcross, tentUp } = lastTracedBuffers();
    const light = (samples: Float32Array, sample: number) =>
      (samples.at(sample * 3) ?? 0) + (samples.at(sample * 3 + 1) ?? 0) + (samples.at(sample * 3 + 2) ?? 0);
    const isNarrow = (sample: number) =>
      surfaceKind.at(sample) === NORTH_WALL &&
      (tentAcross.at(sample) ?? 0) < NARROW_CONE * TENT_PER_DEVIATION &&
      (tentUp.at(sample) ?? 0) < NARROW_CONE * TENT_PER_DEVIATION;
    let edges = 0;
    for (let sample = 0; sample < surfaceKind.length; sample++) {
      for (const next of [sample + 1, sample + reflectedWidth]) {
        if (!isNarrow(sample) || !isNarrow(next) || (next === sample + 1 && next % reflectedWidth === 0)) {
          continue;
        }
        const step = light(reflectedSurface, next) - light(reflectedSurface, sample);
        // An edge: at least a fifth of the brighter side, in light the block's lamp throws.
        if (Math.abs(step) < 0.2 * Math.max(light(reflectedSurface, next), light(reflectedSurface, sample), 0.005)) {
          continue;
        }
        edges++;
        const kept = (light(blurredSurface, next) - light(blurredSurface, sample)) / step;
        expect(kept, `samples ${sample} to ${next}`).toBeGreaterThanOrEqual(0.5);
      }
    }
    expect(edges).toBeGreaterThan(10);
    // Where the cone is wide, the same wall's reflection is blurred.
    let blurredMost = 0;
    for (const [sample, kind] of surfaceKind.entries()) {
      if (kind === NORTH_WALL) {
        blurredMost = Math.max(blurredMost, Math.abs(light(blurredSurface, sample) - light(reflectedSurface, sample)));
      }
    }
    expect(blurredMost).toBeGreaterThan(0.005);
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
