// Positions the fixed 16:9 stage (game + HUD canvases) inside the window.
import { fitViewport, type ViewportBox } from '@zoom3d/shared';

export function layoutStage(stage: HTMLElement, hud: HTMLCanvasElement, pixelPerfect: boolean): ViewportBox {
  const box = fitViewport(window.innerWidth, window.innerHeight, pixelPerfect);
  Object.assign(stage.style, {
    left: `${box.x}px`,
    top: `${box.y}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
  const dpr = window.devicePixelRatio || 1;
  hud.width = Math.round(box.width * dpr);
  hud.height = Math.round(box.height * dpr);
  return box;
}

/** Calls `onChange` whenever the window size or devicePixelRatio changes. */
export function watchLayout(onChange: () => void): void {
  new ResizeObserver(onChange).observe(document.documentElement);
  const watchDpr = () => {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        onChange();
        watchDpr();
      },
      { once: true },
    );
  };
  watchDpr();
}
