import { expect, test } from 'vitest';
import { createTokenBucket } from './rate-limit';

test('allows the burst, then refills at the rate', () => {
  let now = 0;
  const bucket = createTokenBucket(60, 200, () => now);
  for (let i = 0; i < 200; i++) {
    expect(bucket.take()).toBe(true);
  }
  expect(bucket.take()).toBe(false);
  now += 1000;
  for (let i = 0; i < 60; i++) {
    expect(bucket.take()).toBe(true);
  }
  expect(bucket.take()).toBe(false);
});

test('never exceeds the burst after a long idle', () => {
  let now = 0;
  const bucket = createTokenBucket(60, 200, () => now);
  now += 3_600_000;
  let n = 0;
  while (bucket.take()) {
    n++;
  }
  expect(n).toBe(200);
});
