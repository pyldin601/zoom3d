import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curves, REF, MAX } from './public/audio.js';

test('constants match spec §9.2', () => {
  assert.equal(REF, 1.5);
  assert.equal(MAX, 12);
});

test('dry is 1 inside REF and 0 at or beyond MAX', () => {
  assert.equal(curves(0).dry, 1);
  assert.equal(curves(REF).dry, 1);
  assert.equal(curves(MAX).dry, 0);
  assert.equal(curves(50).dry, 0);
});

test('send is 0.15 inside REF and 0 at MAX', () => {
  assert.equal(curves(0).send, 0.15);
  assert.equal(curves(MAX).send, 0);
});

test('dry falls monotonically and the wet/dry ratio rises with distance', () => {
  let prev = curves(REF);
  for (let d = REF + 0.5; d < MAX; d += 0.5) {
    const c = curves(d);
    assert.ok(c.dry < prev.dry, `dry not falling at ${d}`);
    assert.ok(c.send / c.dry > prev.send / prev.dry, `ratio not rising at ${d}`);
    prev = c;
  }
});
