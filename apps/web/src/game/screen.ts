// The game canvas and the framebuffer drawn into it, sized to the window. It shows the title picture (with the
// landing show), the lobby's picture, or the room, which the room loop draws.
import { createFramebuffer, type Framebuffer } from '../renderer/framebuffer';
import { VACUUM_MODEL } from '../renderer/models/vacuum';
import type { VoxelInstance } from '../renderer/voxels';
import { renderLandingScene } from '../ui/landing-scene';
import { createLandingShow, LANDING_PARK } from '../ui/landing-show';
import { startLoop } from './loop';
import type { PageElements, PageFlags } from './page';
import { type Frame, layoutStage, watchLayout } from './stage';

export interface Screen {
  /** A new buffer whenever the frame's size or FOV changes (rotation, resize), never per frame. */
  readonly fb: Framebuffer;
  /** Copies the framebuffer onto the canvas. */
  present(): void;
  /** The landing page's picture, with the robot vacuum's show (landing vacuum spec) unless motion is reduced. */
  showTitle(): void;
  /** The same corridor without the title, behind the lobby. */
  showLobbyPicture(): void;
  /** From now on `frame` draws every animation frame. */
  runRoom(frame: (dt: number) => void): void;
}

type Showing =
  | { kind: 'nothing' }
  | { kind: 'title'; vacuum: VoxelInstance | null; stopShow: (() => void) | null }
  | { kind: 'lobby' }
  | { kind: 'room' };

export function createScreen(page: PageElements, flags: PageFlags): Screen {
  let fb = createFramebuffer();
  let image = imageOf(fb);
  let showing: Showing = { kind: 'nothing' };

  const present = () => page.gameCtx.putImageData(image, 0, 0);

  const drawPicture = (title: boolean, vacuum: VoxelInstance | null) => {
    renderLandingScene(fb, { logo: title, lights: flags.lights, vacuum });
    present();
  };

  /** A still picture has to be drawn again into a new buffer; the room loop draws its own next frame. */
  const redrawPicture = () => {
    if (showing.kind === 'title') {
      drawPicture(true, showing.vacuum);
    } else if (showing.kind === 'lobby') {
      drawPicture(false, null);
    }
  };

  const resize = (frame: Frame) => {
    if (frame.width === fb.width && frame.height === fb.height && frame.fov === fb.fov) {
      return;
    }
    fb = createFramebuffer(frame.width, frame.height, frame.fov);
    image = imageOf(fb);
    page.game.width = fb.width;
    page.game.height = fb.height;
    redrawPicture();
  };

  const relayout = () =>
    resize(layoutStage(page.stage, page.hud, { touch: flags.touch, pixelPerfect: flags.pixelPerfect }));
  relayout();
  watchLayout(relayout, { skipWhileTyping: flags.touch });

  /** Its own small loop, not the room loop, and no input reaches it. */
  const startLandingShow = (title: Extract<Showing, { kind: 'title' }>) => {
    const show = createLandingShow();
    const vacuum: VoxelInstance = { model: VACUUM_MODEL, ...LANDING_PARK };
    title.vacuum = vacuum;
    let drawnInto: Framebuffer | null = null;
    title.stopShow = startLoop((dt) => {
      show.advance(dt);
      // Only the robot moves: while it waits, scans or pauses, the last picture stands.
      if (show.poseInto(vacuum) || drawnInto !== fb) {
        drawnInto = fb;
        drawPicture(true, vacuum);
      }
    });
  };

  const stopLandingShow = () => {
    if (showing.kind === 'title') {
      showing.stopShow?.();
    }
  };

  return {
    get fb() {
      return fb;
    },
    present,
    showTitle() {
      const title: Showing = { kind: 'title', vacuum: null, stopShow: null };
      showing = title;
      drawPicture(true, null);
      if (!flags.reducedMotion) {
        startLandingShow(title);
      }
    },
    showLobbyPicture() {
      stopLandingShow();
      showing = { kind: 'lobby' };
      drawPicture(false, null);
    },
    runRoom(frame) {
      stopLandingShow();
      showing = { kind: 'room' };
      startLoop(frame);
    },
  };
}

function imageOf(fb: Framebuffer): ImageData {
  return new ImageData(new Uint8ClampedArray(fb.pixels.buffer as ArrayBuffer), fb.width, fb.height);
}
