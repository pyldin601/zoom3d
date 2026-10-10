import { expect, test } from 'vitest';
import { createLogger, parseLogLevel } from './log';

function capture(level?: Parameters<typeof parseLogLevel>[0]) {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    level: parseLogLevel(level),
    write: (line) => lines.push(JSON.parse(line)),
    now: () => Date.UTC(2026, 9, 10, 12, 0, 0),
  });
  return { log, lines };
}

test('writes one JSON object per line with time, level, msg and fields', () => {
  const lines: string[] = [];
  const log = createLogger({ write: (l) => lines.push(l), now: () => Date.UTC(2026, 9, 10, 12, 0, 0) });
  log.info('peer_joined', { roomId: 'r1', peers: 2 });
  expect(lines).toEqual([
    '{"time":"2026-10-10T12:00:00.000Z","level":"info","msg":"peer_joined","roomId":"r1","peers":2}\n',
  ]);
});

test('drops records below the configured level', () => {
  const { log, lines } = capture('warn');
  log.debug('a');
  log.info('b');
  log.warn('c');
  log.error('d');
  expect(lines.map((l) => l.msg)).toEqual(['c', 'd']);
});

test('serialises errors with message and stack', () => {
  const { log, lines } = capture();
  const err = Object.assign(new Error('boom'), { code: 'EACCES' });
  log.error('snapshot_write_failed', { err });
  expect(lines[0]?.err).toMatchObject({ message: 'boom', code: 'EACCES', stack: expect.stringContaining('boom') });
});

test('fields cannot overwrite time, level or msg', () => {
  const { log, lines } = capture();
  log.info('real', { msg: 'fake', level: 'error' });
  expect(lines[0]).toMatchObject({ level: 'info', msg: 'real' });
});

test('parseLogLevel defaults to info and ignores unknown values', () => {
  expect(parseLogLevel(undefined)).toBe('info');
  expect(parseLogLevel('DEBUG')).toBe('debug');
  expect(parseLogLevel('verbose')).toBe('info');
});
