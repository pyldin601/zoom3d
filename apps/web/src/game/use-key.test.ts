import { describe, expect, test } from 'vitest';
import { chooseUse } from './use-key';

// Ball dribble spec §2.1, §4.2: one E for the scooter and the ball.
describe('chooseUse', () => {
  const onFoot = { riding: false, dribbling: false, ballTiles: null, scooterTiles: null };

  test('riding, E steps off, even with the ball nearer', () => {
    expect(chooseUse({ ...onFoot, riding: true, ballTiles: 0.1, scooterTiles: null })).toBe('dismount');
  });

  test('dribbling, E lets go, even with a scooter in reach', () => {
    expect(chooseUse({ ...onFoot, dribbling: true, scooterTiles: 0.2 })).toBe('letGo');
  });

  test('on foot the nearer of the ball and a scooter wins', () => {
    expect(chooseUse({ ...onFoot, ballTiles: 0.5, scooterTiles: 0.8 })).toBe('dribble');
    expect(chooseUse({ ...onFoot, ballTiles: 0.9, scooterTiles: 0.4 })).toBe('ride');
    expect(chooseUse({ ...onFoot, ballTiles: 0.5 })).toBe('dribble');
    expect(chooseUse({ ...onFoot, scooterTiles: 0.5 })).toBe('ride');
  });

  test('with nothing in reach E does nothing', () => {
    expect(chooseUse(onFoot)).toBeNull();
  });
});
