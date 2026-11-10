// What E (or the touch use button) does (ball dribble spec §2.1): one key for the scooter and the ball. Riding it only
// steps off and dribbling it only lets go; on foot the nearer thing in reach wins. Pure.

export type UseChoice = 'dismount' | 'letGo' | 'dribble' | 'ride';

export interface UseState {
  riding: boolean;
  dribbling: boolean;
  /** How far the loose ball is, in tiles, when it is in reach; else null. */
  ballTiles: number | null;
  /** How far the nearest parked scooter is, in tiles, when one is in reach; else null. */
  scooterTiles: number | null;
}

export function chooseUse(s: UseState): UseChoice | null {
  if (s.riding) {
    return 'dismount';
  }
  if (s.dribbling) {
    return 'letGo';
  }
  if (s.ballTiles !== null && (s.scooterTiles === null || s.ballTiles <= s.scooterTiles)) {
    return 'dribble';
  }
  return s.scooterTiles === null ? null : 'ride';
}
