// The sip animation's progress (held items spec §2.3): there, held, back, with eased moves.
import { SIP_MS } from '@zoom3d/shared';

const MOVE_MS = 350;

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** 0 at rest, 1 while the drink is at the mouth, for `elapsedMs` since the sip started. */
export function sipPose(elapsedMs: number): number {
  if (!(elapsedMs >= 0 && elapsedMs < SIP_MS)) {
    return 0;
  }
  if (elapsedMs < MOVE_MS) {
    return easeInOut(elapsedMs / MOVE_MS);
  }
  if (elapsedMs <= SIP_MS - MOVE_MS) {
    return 1;
  }
  return easeInOut((SIP_MS - elapsedMs) / MOVE_MS);
}
