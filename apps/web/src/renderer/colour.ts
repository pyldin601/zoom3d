// Colour mixing that doesn't invent hues. Light adds in RGB, which sets how bright the result gets; its hue and
// saturation come from OKLab, where a warm light mixed into blue passes through grey towards the light's colour,
// never sideways into violet as plain RGB addition does.

type Rgb = readonly [number, number, number];

/** A typical reflection's strength (added per channel, 0..255) to work the mix out at. */
const REFERENCE = 40;

/** OKLab of an sRGB-encoded colour (0..255), skipping the gamma step: cheaper, and the opponent axes still hold. */
function toOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt((0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) / 255);
  const m = Math.cbrt((0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) / 255);
  const s = Math.cbrt((0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) / 255);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab(lightness: number, a: number, b: number): [number, number, number] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    255 * (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    255 * (-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    255 * (-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Perceived brightness of linear r, g, b (Rec. 709 weights), on whatever scale the channels use. */
export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * What one unit of `light` reflected off a surface of colour `base` adds to it, per channel, never shifting it to a
 * new hue. `tint` (0..1) is how much of the reflection is more of the surface's own colour (its hue at the light's
 * brightest channel); the rest is the light itself, mixed in once per material and lamp at a typical strength: as
 * bright as plain addition, its OKLab colour axes the surface's and the light's, weighted by how bright each is. That
 * part alone keeps the lamp's brightness, which on a dark saturated blue (blue weighs little in brightness) means a
 * lot of red and green: a white wash. So shiny brick mostly takes its own colour.
 */
export function reflectedColour(base: Rgb, light: { r: number; g: number; b: number }, tint: number): Rgb {
  const [r0, g0, b0] = base;
  const r1 = light.r * REFERENCE;
  const g1 = light.g * REFERENCE;
  const b1 = light.b * REFERENCE;
  const [lightness] = toOklab(Math.min(255, r0 + r1), Math.min(255, g0 + g1), Math.min(255, b0 + b1));
  const [, baseA, baseB] = toOklab(r0, g0, b0);
  const [, lightA, lightB] = toOklab(r1, g1, b1);
  const baseWeight = luma(r0, g0, b0);
  const lightWeight = luma(r1, g1, b1);
  const total = baseWeight + lightWeight;
  const [r, g, b] = fromOklab(
    lightness,
    (baseWeight * baseA + lightWeight * lightA) / total,
    (baseWeight * baseB + lightWeight * lightB) / total
  );
  const own = Math.max(light.r, light.g, light.b) / Math.max(r0, g0, b0, 1);
  return [
    tint * r0 * own + ((1 - tint) * (r - r0)) / REFERENCE,
    tint * g0 * own + ((1 - tint) * (g - g0)) / REFERENCE,
    tint * b0 * own + ((1 - tint) * (b - b0)) / REFERENCE,
  ];
}
