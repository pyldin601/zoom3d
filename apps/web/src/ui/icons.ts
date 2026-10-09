// Line icons shared by the lobby and the room bar, drawn as inline SVG (styled by CSS through currentColor).

const SVG = 'http://www.w3.org/2000/svg';

/** The mic's capsule (`M9 3h6v11H9z` below), in the 24-unit viewBox. */
export const MIC_CAPSULE = { x: 9, bottom: 14, width: 6, height: 11 };

/** A camera or mic icon; `off` adds a slash. */
export function deviceIcon(kind: 'cam' | 'mic', off: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const paths =
    kind === 'cam' ? ['M3 7h12v10H3z', 'M15 10l6-3v10l-6-3'] : ['M9 3h6v11H9z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'];
  if (off) {
    paths.push('M3 3l18 18');
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
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
