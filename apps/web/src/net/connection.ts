// WebSocket connection with join-on-open, exponential-backoff reconnect and fatal-error stop.
import {
  type ClientMessage,
  type ErrorCode,
  type JoinMessage,
  parseServerMessage,
  type ServerMessage,
} from '@zoom3d/shared';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'failed';

/** Errors no retry can fix: the session stops. */
const FATAL_ERRORS: readonly ErrorCode[] = ['room_full', 'invalid_room', 'invalid_name', 'outdated'];
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5000;
/**
 * A socket without a welcome by then is given up. Browsers let only one WebSocket per host sit in CONNECTING,
 * so a hung handshake (a proxy waiting on a restarting server) would otherwise block every retry behind it.
 */
const WELCOME_TIMEOUT_MS = 10_000;
/** WebSocket.OPEN, which a test's fake socket class may not define. */
const READY_STATE_OPEN = 1;

export interface ConnectOptions {
  url: string;
  makeJoin: () => JoinMessage;
  onMessage: (m: ServerMessage) => void;
  onStatus: (s: ConnStatus) => void;
  WebSocketImpl?: typeof WebSocket;
}

export function connect(opts: ConnectOptions): { send(m: ClientMessage): void; close(): void } {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  let ws: WebSocket;
  let retries = 0;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    opts.onStatus(retries === 0 ? 'connecting' : 'reconnecting');
    const socket = new Impl(opts.url);
    ws = socket;
    const deadline = setTimeout(() => socket.close(), WELCOME_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify(opts.makeJoin()));
    ws.onmessage = (e) => {
      const msg = parseServerMessage(String(e.data));
      if (!msg) {
        return;
      }
      if (msg.type === 'welcome') {
        clearTimeout(deadline);
        retries = 0;
        opts.onStatus('open');
      }
      if (msg.type === 'error' && FATAL_ERRORS.includes(msg.code)) {
        stopped = true;
        opts.onStatus('failed');
      }
      opts.onMessage(msg);
    };
    ws.onclose = () => {
      clearTimeout(deadline);
      if (stopped) {
        return;
      }
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** retries);
      retries++;
      opts.onStatus('reconnecting');
      retryTimer = setTimeout(open, delay);
    };
  };
  open();

  return {
    send(m) {
      if (ws.readyState === READY_STATE_OPEN) {
        ws.send(JSON.stringify(m));
      }
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      ws.close();
    },
  };
}
