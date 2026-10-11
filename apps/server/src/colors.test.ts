import { MAX_PEERS, PEER_COLORS } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { pickColor } from './colors';

const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

test('the first eight people get the fixed colours, in order', () => {
  const used = new Set<string>();
  for (const c of PEER_COLORS) {
    expect(pickColor(used)).toBe(c);
    used.add(c);
  }
});

test('a full room gets distinct, valid, saturated colours', () => {
  const used = new Set<string>();
  for (let i = 0; i < MAX_PEERS; i++) {
    const c = pickColor(used);
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(used.has(c)).toBe(false);
    const rgb = channels(c);
    // Not grey: bots are grey, people must stand out.
    expect(Math.max(...rgb) - Math.min(...rgb)).toBeGreaterThanOrEqual(64);
    used.add(c);
  }
});

test('a colour freed by someone leaving is reused, and used ones are skipped', () => {
  const used = new Set<string>(PEER_COLORS);
  const ninth = pickColor(used);
  used.add(ninth);
  const tenth = pickColor(used);
  expect(tenth).not.toBe(ninth);
  used.delete(PEER_COLORS[2]);
  expect(pickColor(used)).toBe(PEER_COLORS[2]);
});
