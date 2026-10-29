// Every eye a frame's passes may draw from: the frame's own, and each carried through a window it may show, down to
// WINDOW_LEVELS (portal doorways spec §2.5), each seeing only its window's columns. What none of them sees, no pass
// draws. Its eyes are reused objects.
import { applyDir, applyPoint, type Portal, type Portals } from '@zoom3d/shared';
import { type View, WINDOW_LEVELS } from './camera';

/** Where an eye stands and which way it looks, as a View has it. */
export type Eye = Pick<View, 'x' | 'y' | 'dirX' | 'dirY' | 'planeX' | 'planeY'>;

/**
 * An eye and the columns its pass may draw: its rays run from dir + plane · left to dir + plane · right (the frame's
 * edges are −1 and 1).
 */
interface PassEye extends Eye {
  left: number;
  right: number;
}

export interface FrameEyes {
  readonly count: number;
  /** Starts the list over with the frame's own eye, copied, seeing the whole frame. */
  reset(eye: Eye): void;
  /**
   * Adds the eye carried through each window `portalAt` (one entry per frame column) shows on columns
   * [fromCol, toCol), then, level by level, the eyes through every window those eyes may show.
   */
  addWindowEyes(portals: Portals, portalAt: Int32Array, fromCol: number, toCol: number): void;
  /** Whether anything within `reach` tiles of (x, y) is in view of any of the eyes. */
  mayShow(x: number, y: number, reach: number): boolean;
}

/** A doorway's opening runs this far either side of its centre, tiles. */
const HALF_OPENING = 0.5;
const WHOLE_FRAME_LEFT = -1;
const WHOLE_FRAME_RIGHT = 1;

export function createFrameEyes(): FrameEyes {
  const eyes: PassEye[] = [];
  let count = 0;
  /** Per portal, the first and last frame column showing its window, −1 for none. */
  let firstWindowCol = new Int32Array(0);
  let lastWindowCol = new Int32Array(0);
  const carried = { x: 0, y: 0 };

  const nextEye = (): PassEye => {
    let eye = eyes.at(count);
    if (!eye) {
      eye = { x: 0, y: 0, dirX: 0, dirY: 0, planeX: 0, planeY: 0, left: 0, right: 0 };
      eyes.push(eye);
    }
    count++;
    return eye;
  };

  const addThrough = (portal: Portal, from: Eye, left: number, right: number) => {
    const eye = nextEye();
    const { toDest } = portal;
    applyPoint(toDest, from.x, from.y, eye);
    applyDir(toDest, from.dirX, from.dirY, carried);
    eye.dirX = carried.x;
    eye.dirY = carried.y;
    applyDir(toDest, from.planeX, from.planeY, carried);
    eye.planeX = carried.x;
    eye.planeY = carried.y;
    eye.left = left;
    eye.right = right;
  };

  const findWindowColumns = (portals: Portals, portalAt: Int32Array, fromCol: number, toCol: number) => {
    if (firstWindowCol.length !== portals.list.length) {
      firstWindowCol = new Int32Array(portals.list.length);
      lastWindowCol = new Int32Array(portals.list.length);
    }
    firstWindowCol.fill(-1);
    for (let col = fromCol; col < toCol; col++) {
      const index = portalAt[col] as number;
      if (index < 0 || index >= portals.list.length) {
        continue;
      }
      if (firstWindowCol[index] === -1) {
        firstWindowCol[index] = col;
      }
      lastWindowCol[index] = col;
    }
  };

  const addThroughShownWindows = (portals: Portals, portalAt: Int32Array, fromCol: number, toCol: number) => {
    const frameEye = eyes.at(0);
    if (!frameEye) {
      return;
    }
    findWindowColumns(portals, portalAt, fromCol, toCol);
    const columnToCameraX = 2 / portalAt.length;
    portals.list.forEach((portal, index) => {
      const first = firstWindowCol[index] as number;
      if (first >= 0) {
        const last = lastWindowCol[index] as number;
        addThrough(portal, frameEye, first * columnToCameraX - 1, last * columnToCameraX - 1);
      }
    });
  };

  return {
    get count() {
      return count;
    },
    reset(eye) {
      count = 0;
      const own = nextEye();
      own.x = eye.x;
      own.y = eye.y;
      own.dirX = eye.dirX;
      own.dirY = eye.dirY;
      own.planeX = eye.planeX;
      own.planeY = eye.planeY;
      own.left = WHOLE_FRAME_LEFT;
      own.right = WHOLE_FRAME_RIGHT;
    },
    addWindowEyes(portals, portalAt, fromCol, toCol) {
      let levelStart = count;
      addThroughShownWindows(portals, portalAt, fromCol, toCol);
      // A window's pass draws within its window's columns, and so does every pass inside it.
      for (let level = 2; level <= WINDOW_LEVELS; level++) {
        const levelEnd = count;
        for (let i = levelStart; i < levelEnd; i++) {
          const from = eyes.at(i);
          for (const portal of portals.list) {
            if (from && mayShowWindow(from, portal)) {
              addThrough(portal, from, from.left, from.right);
            }
          }
        }
        levelStart = levelEnd;
      }
    },
    mayShow(x, y, reach) {
      for (let i = 0; i < count; i++) {
        const eye = eyes.at(i);
        if (eye && !outOfColumns(eye, eye.left, eye.right, x, y, reach)) {
          return true;
        }
      }
      return false;
    },
  };
}

/** Whether `eye` may see `portal`'s window: from the doorway's front, with some of its opening in view. */
function mayShowWindow(eye: PassEye, portal: Portal): boolean {
  const inFront = (eye.x - portal.cx) * portal.nx + (eye.y - portal.cy) * portal.ny < 0;
  return inFront && !outOfColumns(eye, eye.left, eye.right, portal.cx, portal.cy, HALF_OPENING);
}

/** Whether everything within `reach` tiles of (x, y) lies behind `eye` or past the left or right edge of its frame. */
export function outOfView(eye: Eye, x: number, y: number, reach: number): boolean {
  return outOfColumns(eye, WHOLE_FRAME_LEFT, WHOLE_FRAME_RIGHT, x, y, reach);
}

/**
 * Whether everything within `reach` tiles of (x, y) lies behind `eye` or outside its rays from dir + plane · left to
 * dir + plane · right.
 */
function outOfColumns(eye: Eye, left: number, right: number, x: number, y: number, reach: number): boolean {
  const ox = x - eye.x;
  const oy = y - eye.y;
  const depth = ox * eye.dirX + oy * eye.dirY;
  if (depth < -reach) {
    return true;
  }
  // An edge ray runs `slope` tiles across per tile of depth; a point's distance outside it is measured square to it.
  const planeLen = Math.sqrt(eye.planeX * eye.planeX + eye.planeY * eye.planeY);
  const across = (ox * eye.planeX + oy * eye.planeY) / planeLen;
  const leftSlope = left * planeLen;
  const rightSlope = right * planeLen;
  const pastLeft = (leftSlope * depth - across) / Math.sqrt(1 + leftSlope * leftSlope);
  const pastRight = (across - rightSlope * depth) / Math.sqrt(1 + rightSlope * rightSlope);
  return pastLeft > reach || pastRight > reach;
}
