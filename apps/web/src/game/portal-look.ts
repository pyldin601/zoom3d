// Which portals the eye sees through (D38): the room's own while classic is chosen, the photon set once realistic is
// chosen and its lighting baked. Sight and light switch together, never one without the other. Pure.
import type { Portals } from '@zoom3d/shared';
import type { PortalLook } from '../ui/render-settings';

export function shownPortals(
  classic: Portals | null,
  photon: Portals,
  look: PortalLook,
  realisticReady: boolean
): Portals | null {
  if (classic === null) {
    return null;
  }
  return look === 'realistic' && realisticReady ? photon : classic;
}
