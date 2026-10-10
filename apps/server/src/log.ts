// Structured logs: one JSON object per line on stdout, for `kubectl logs` and log shippers.
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => number;
}

/** `LOG_LEVEL` is case-insensitive; anything unknown means `info`. */
export function parseLogLevel(v: string | undefined): LogLevel {
  const level = v?.toLowerCase();
  return LOG_LEVELS.find((l) => l === level) ?? 'info';
}

function serialise(_key: string, v: unknown): unknown {
  if (v instanceof Error) {
    return { ...v, message: v.message, stack: v.stack };
  }
  return v;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = LOG_LEVELS.indexOf(opts.level ?? 'info');
  const write = opts.write ?? ((line: string) => process.stdout.write(line));
  const now = opts.now ?? Date.now;
  const at =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      if (LOG_LEVELS.indexOf(level) < min) {
        return;
      }
      const { time: _t, level: _l, msg: _m, ...rest } = fields ?? {};
      write(`${JSON.stringify({ time: new Date(now()).toISOString(), level, msg, ...rest }, serialise)}\n`);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
