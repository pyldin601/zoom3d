// WebSocket connection with join-on-open, exponential-backoff reconnect and fatal-error stop.
import {
  type ClientMessage,
  type ErrorCode,
  type JoinMessage,
  parseServerMessage,
  type ServerMessage,
} from '@zoom3d/shared';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'failed';

const FATAL: readonly ErrorCode[] = ['room_full', 'invalid_room', 'invalid_name'];
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5000;
const OPEN = 1;

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
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    opts.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    ws = new Impl(opts.url);
    ws.onopen = () => ws.send(JSON.stringify(opts.makeJoin()));
    ws.onmessage = (e) => {
      const msg = parseServerMessage(String(e.data));
      if (!msg) return;
      if (msg.type === 'welcome') {
        attempt = 0;
        opts.onStatus('open');
      }
      if (msg.type === 'error' && FATAL.includes(msg.code)) {
        stopped = true;
        opts.onStatus('failed');
      }
      opts.onMessage(msg);
    };
    ws.onclose = () => {
      if (stopped) return;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
      attempt++;
      opts.onStatus('reconnecting');
      timer = setTimeout(open, delay);
    };
  };
  open();

  return {
    send(m) {
      if (ws.readyState === OPEN) ws.send(JSON.stringify(m));
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      ws.close();
    },
  };
}
