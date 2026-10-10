// Line icons shared by the lobby, the room bar and the touch controls, drawn as inline SVG (styled by CSS through currentColor).

const SVG = 'http://www.w3.org/2000/svg';

/** The mic's capsule (`M9 3h6v11H9z` below), in the 24-unit viewBox. */
export const MIC_CAPSULE = { x: 9, bottom: 14, width: 6, height: 11 };

function icon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** A camera or mic icon; `off` adds a slash. */
export function deviceIcon(kind: 'cam' | 'mic', off: boolean): SVGSVGElement {
  const paths =
    kind === 'cam' ? ['M3 7h12v10H3z', 'M15 10l6-3v10l-6-3'] : ['M9 3h6v11H9z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'];
  if (off) {
    paths.push('M3 3l18 18');
  }
  return icon(paths);
}

const dot = (x: number) => `M${x} 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2`;

const TOUCH_ICONS = {
  beer: ['M6 6h9v14H6z', 'M6 9h9', 'M15 9h3v7h-3'],
  coffee: ['M5 9h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z', 'M16 11h2a2 2 0 0 1 0 4h-2', 'M9 3v3', 'M12 3v3'],
  wine: ['M8 3h8v4a4 4 0 0 1-8 0z', 'M12 11v9', 'M8 21h8'],
  none: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M6 6l12 12'],
  boombox: ['M3 9h18v11H3z', 'M8 9V5h8v4', 'M6 13h4v4H6z', 'M14 13h4v4h-4z'],
  map: ['M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z', 'M9 3v15', 'M15 6v15'],
  more: [dot(5), dot(12), dot(19)],
  link: ['M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1', 'M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1'],
} as const;

/** Icons for the touch controls (mobile spec §5): drinks, boombox, map, the ⋯ button and the copy-link button. */
export function touchIcon(kind: keyof typeof TOUCH_ICONS): SVGSVGElement {
  return icon(TOUCH_ICONS[kind]);
}

/** Adds the lobby's level fill to a mic icon, under the outline; `setMeter` sets its height. */
export function addMeter(svg: SVGSVGElement): SVGRectElement {
  const rect = document.createElementNS(SVG, 'rect');
  rect.setAttribute('class', 'meter');
  rect.setAttribute('x', String(MIC_CAPSULE.x));
  rect.setAttribute('width', String(MIC_CAPSULE.width));
  svg.prepend(rect);
  return rect;
}

/** Fills the capsule from the bottom, `height` icon units tall. */
export function setMeter(rect: SVGRectElement, height: number): void {
  rect.setAttribute('y', String(MIC_CAPSULE.bottom - height));
  rect.setAttribute('height', String(height));
}
