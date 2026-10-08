// Mesh MediaTransport: one RTCPeerConnection per remote peer, MDN "perfect negotiation".
// The peer with the lexicographically smaller id is polite (yields on offer collisions).
import type { IceServer, SignalPayload } from '@zoom3d/shared';

export const VIDEO_MAX_BITRATE = 150_000;

export interface MediaTransport {
  connect(peerId: string): void;
  handleSignal(from: string, payload: SignalPayload): Promise<void>;
  disconnect(peerId: string): void;
  close(): void;
  stats(peerId: string): Promise<{ bytesReceived: number } | null>;
}

export interface MeshOptions {
  selfId: string;
  iceServers: IceServer[];
  localStream: MediaStream | null;
  sendSignal: (to: string, payload: SignalPayload) => void;
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
}

interface Conn {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

export function createMesh(opts: MeshOptions): MediaTransport {
  const Impl = opts.RTCPeerConnectionImpl ?? RTCPeerConnection;
  const conns = new Map<string, Conn>();
  const local = opts.localStream;

  const describe = (pc: RTCPeerConnection): SignalPayload => {
    const d = pc.localDescription as RTCSessionDescription;
    return { kind: 'description', description: { type: d.type, sdp: d.sdp } };
  };

  function create(peerId: string): Conn {
    const pc = new Impl({ iceServers: opts.iceServers });
    const conn: Conn = { pc, polite: opts.selfId < peerId, makingOffer: false, ignoreOffer: false };
    conns.set(peerId, conn);

    // Video and audio share the local stream so the remote side sees one MediaStream.
    const video = local?.getVideoTracks()[0];
    const audio = local?.getAudioTracks()[0];
    if (video && local) {
      pc.addTransceiver(video, {
        direction: 'sendrecv',
        streams: [local],
        sendEncodings: [{ maxBitrate: VIDEO_MAX_BITRATE }],
      });
    } else {
      pc.addTransceiver('video', { direction: 'recvonly' });
    }
    if (audio && local) pc.addTrack(audio, local);
    else pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.onnegotiationneeded = async () => {
      try {
        conn.makingOffer = true;
        await pc.setLocalDescription();
        opts.sendSignal(peerId, describe(pc));
      } catch (err) {
        console.warn('negotiation failed', peerId, err);
      } finally {
        conn.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate: c }) => {
      opts.sendSignal(peerId, {
        kind: 'candidate',
        candidate: c
          ? {
              candidate: c.candidate,
              sdpMid: c.sdpMid ?? null,
              sdpMLineIndex: c.sdpMLineIndex ?? null,
              usernameFragment: c.usernameFragment ?? null,
            }
          : null,
      });
    };
    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (stream) opts.onRemoteStream(peerId, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
    };
    return conn;
  }

  return {
    connect(peerId) {
      if (!conns.has(peerId)) create(peerId);
    },

    async handleSignal(from, payload) {
      let conn = conns.get(from);
      if (!conn) {
        // Only a fresh offer may open a connection; stray candidates/answers are stale.
        if (payload.kind !== 'description' || payload.description.type !== 'offer') return;
        conn = create(from);
      }
      const { pc } = conn;
      try {
        if (payload.kind === 'description') {
          const d = payload.description;
          const collision = d.type === 'offer' && (conn.makingOffer || pc.signalingState !== 'stable');
          conn.ignoreOffer = !conn.polite && collision;
          if (conn.ignoreOffer) return;
          await pc.setRemoteDescription(d);
          if (d.type === 'offer') {
            await pc.setLocalDescription();
            opts.sendSignal(from, describe(pc));
          }
        } else {
          try {
            await pc.addIceCandidate(payload.candidate ?? undefined);
          } catch (err) {
            if (!conn.ignoreOffer) throw err;
          }
        }
      } catch (err) {
        console.warn('signal handling failed', from, err);
      }
    },

    disconnect(peerId) {
      conns.get(peerId)?.pc.close();
      conns.delete(peerId);
    },

    close() {
      for (const { pc } of conns.values()) pc.close();
      conns.clear();
    },

    async stats(peerId) {
      const conn = conns.get(peerId);
      if (!conn) return null;
      let bytesReceived = 0;
      (await conn.pc.getStats()).forEach((r: { type: string; bytesReceived?: number }) => {
        if (r.type === 'inbound-rtp') bytesReceived += r.bytesReceived ?? 0;
      });
      return { bytesReceived };
    },
  };
}
