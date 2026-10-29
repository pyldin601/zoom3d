import { describe, expect, test } from 'vitest';
import { createView, setView } from './camera';
import { createFrameEyes, outOfView } from './frame-eyes';
import { portalHall } from './test-portals';

const FRAME = { width: 64, height: 36, fov: Math.PI / 2 };
const SOUTH = Math.PI / 2;

/** The eye 1.5 tiles north of doorway A, facing south into it. */
const eyeBeforeA = () => setView(createView(), FRAME, { x: 2.5, y: 2, angle: SOUTH });

describe('outOfView', () => {
  const eye = eyeBeforeA();

  test('a point ahead, inside the frame, is in view', () => {
    expect(outOfView(eye, 2.5, 4, 0.1)).toBe(false);
  });

  test('a point behind the eye is out of view, unless its reach comes round the eye', () => {
    expect(outOfView(eye, 2.5, 1, 0.5)).toBe(true);
    expect(outOfView(eye, 2.5, 1, 1.5)).toBe(false);
  });

  test('a point far past the edge of the frame is out of view', () => {
    expect(outOfView(eye, 7, 2.5, 0.5)).toBe(true);
  });
});

describe('createFrameEyes', () => {
  /** A frame whose columns all show window `portal`, or none at −1. */
  const columnsShowing = (portal: number) => new Int32Array(FRAME.width).fill(portal);

  test('without windows only the frame’s own eye sees', () => {
    const { portals } = portalHall();
    const eyes = createFrameEyes();
    eyes.reset(eyeBeforeA());
    eyes.addWindowEyes(portals, columnsShowing(-1), 0, FRAME.width);
    expect(eyes.count).toBe(1);
    expect(eyes.mayShow(4.5, 1, 0.5)).toBe(false);
  });

  test('a window adds the eye carried through it once, however many runs show it', () => {
    const { portals } = portalHall();
    const eyes = createFrameEyes();
    eyes.reset(eyeBeforeA());
    const portalAt = columnsShowing(0);
    portalAt[10] = -1;
    eyes.addWindowEyes(portals, portalAt, 0, FRAME.width);
    // Through A the eye stands south of B facing north; from there B may show a window at the next level (an eye
    // back where it began), and A, whose back it sees, may not.
    expect(eyes.count).toBe(3);
  });

  test('a point behind the frame’s eye but ahead of the eye through the window may show', () => {
    const { portals } = portalHall();
    const eyes = createFrameEyes();
    eyes.reset(eyeBeforeA());
    eyes.addWindowEyes(portals, columnsShowing(0), 0, FRAME.width);
    expect(eyes.mayShow(4.5, 1, 0.5)).toBe(true);
  });

  test('an eye through a window sees only the window’s columns', () => {
    const { portals } = portalHall();
    const eyes = createFrameEyes();
    eyes.reset(eyeBeforeA());
    const portalAt = columnsShowing(-1);
    portalAt.fill(0, 30, 34);
    eyes.addWindowEyes(portals, portalAt, 0, FRAME.width);
    // Through A the eye looks north from (4.5, 5): (5.5, 1) is in its frame, but well right of the window.
    expect(eyes.mayShow(4.5, 1, 0.5)).toBe(true);
    expect(eyes.mayShow(5.5, 1, 0.5)).toBe(false);
    eyes.addWindowEyes(portals, columnsShowing(0), 0, FRAME.width);
    expect(eyes.mayShow(5.5, 1, 0.5)).toBe(true);
  });

  test('reset forgets the window eyes', () => {
    const { portals } = portalHall();
    const eyes = createFrameEyes();
    eyes.reset(eyeBeforeA());
    eyes.addWindowEyes(portals, columnsShowing(0), 0, FRAME.width);
    eyes.reset(eyeBeforeA());
    expect(eyes.count).toBe(1);
    expect(eyes.mayShow(4.5, 1, 0.5)).toBe(false);
  });
});
