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
import { FACE_REFLECTION_GAIN } from './people';
import { bakeRoom, drawOverNaN, expectEveryPixelWritten, pixelOf } from './test-helpers';
import { shownPixel } from './tone';
import { linearOfSrgbChannel, TRACED_MATERIALS, type TracedWorld } from './world';

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
