// Prometheus metrics, served at /metrics. Each server gets its own registry, so tests don't share counters.
import { Counter, collectDefaultMetrics, Gauge, Registry } from '@prometheus-io/client';
import type { LobbyStats } from './lobby';

export interface MetricsSources {
  connections(): number;
  lobby(): LobbyStats;
}

export type Metrics = ReturnType<typeof createMetrics>;

export function createMetrics(src: MetricsSources) {
  const registry = new Registry();
  const registers = [registry];
  collectDefaultMetrics({ register: registry });

  new Gauge({
    name: 'zoom3d_connections',
    help: 'Open WebSocket connections.',
    registers,
    collect() {
      this.set(src.connections());
    },
  });
  new Gauge({
    name: 'zoom3d_rooms',
    help: 'Rooms with at least one peer, connected or in grace.',
    registers,
    collect() {
      this.set(src.lobby().rooms);
    },
  });
  new Gauge({
    name: 'zoom3d_peers',
    help: 'Peers by state: connected, waiting out their resume grace period, or a server-driven bot.',
    labelNames: ['state'],
    registers,
    collect() {
      const { connected, waiting, bots } = src.lobby();
      this.set({ state: 'connected' }, connected);
      this.set({ state: 'waiting' }, waiting);
      this.set({ state: 'bot' }, bots);
    },
  });

  return {
    registry,
    connectionsOpened: new Counter({
      name: 'zoom3d_connections_opened_total',
      help: 'WebSocket connections accepted.',
      registers,
    }),
    connectionsTerminated: new Counter({
      name: 'zoom3d_connections_terminated_total',
      help: 'Connections the server cut: flooding (rate_limit) or no pong (heartbeat).',
      labelNames: ['reason'],
      registers,
    }),
    joins: new Counter({
      name: 'zoom3d_joins_total',
      help: 'Join attempts by result: new, resumed, or the rejection reason.',
      labelNames: ['result'],
      registers,
    }),
    peersLeft: new Counter({
      name: 'zoom3d_peers_left_total',
      help: 'Peers removed after their resume grace ran out.',
      registers,
    }),
    messages: new Counter({
      name: 'zoom3d_messages_total',
      help: 'Valid client messages by type.',
      labelNames: ['type'],
      registers,
    }),
    messagesSent: new Counter({
      name: 'zoom3d_messages_sent_total',
      help: 'Server messages delivered to clients by type (a broadcast counts once per recipient).',
      labelNames: ['type'],
      registers,
    }),
    bytesSent: new Counter({
      name: 'zoom3d_bytes_sent_total',
      help: 'Bytes of server messages delivered to clients by type (WebSocket payload, before framing).',
      labelNames: ['type'],
      registers,
    }),
    messagesDropped: new Counter({
      name: 'zoom3d_messages_dropped_total',
      help: 'Client messages dropped: over the rate limit, binary, or failing validation.',
      labelNames: ['reason'],
      registers,
    }),
    moveCorrections: new Counter({
      name: 'zoom3d_move_corrections_total',
      help: 'Implausible moves answered with a correction.',
      registers,
    }),
  };
}
