// The first switch-on's countdown (portal sequence spec §2.1): "Portals will enable in 3…", then 2…, then 1….
import { countdownText } from '@zoom3d/shared';

/** The element on screen and the number it shows, so a frame that changes nothing touches nothing. */
let shown: { element: HTMLElement; n: 3 | 2 | 1 } | null = null;

/** Shows `n` in one centred element in `ui`, updating it in place, and removes it on null. Called every frame. */
export function showCountdown(ui: HTMLElement, n: 3 | 2 | 1 | null): void {
  if (n === null) {
    shown?.element.remove();
    shown = null;
    return;
  }
  if (shown?.element.parentElement === ui && shown.n === n) {
    return;
  }
  if (shown?.element.parentElement !== ui) {
    shown?.element.remove();
    const element = document.createElement('div');
    element.className = 'portal-countdown';
    ui.append(element);
    shown = { element, n };
  }
  shown.n = n;
  shown.element.textContent = countdownText(n);
}
