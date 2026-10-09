// Mesh MediaTransport: one RTCPeerConnection per remote peer.
// Only the peer with the greater id initiates (sends the first offer); the other side answers and
// attaches its tracks to the offered transceivers. This avoids initial glare, whose rollback makes
// Chrome stop gathering ICE candidates. Later renegotiations use MDN "perfect negotiation", where the
// peer with the smaller id is polite.
import type { IceServer, SignalPayload } from '@zoom3d/shared';

export const VIDEO_MAX_BITRATE = 350_000;
/** An initiator connection that is not `connected` for this long is recreated with a fresh offer. */
export const WATCHDOG_MS = 10_000;
export const WATCHDOG_CHECK_MS = 2_000;

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
  /** Answerer side: local tracks get attached once the first offer has created transceivers. */
  tracksAttached: boolean;
  initiator: boolean;
  /** Last time this connection was known healthy (or was created). */
  since: number;
  /** DTLS fingerprint of the remote offer this connection was built for. */
  remoteFingerprint: string | null;
}

const fingerprintOf = (sdp: string) => /^a=fingerprint:(.+)$/m.exec(sdp)?.[1]?.trim() ?? null;

export function createMesh(opts: MeshOptions): MediaTransport {
  const Impl = opts.RTCPeerConnectionImpl ?? RTCPeerConnection;
  const conns = new Map<string, Conn>();
  const local = opts.localStream;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  // Signalling can be lost (socket blip, peer in resume grace); only the initiator can fix that,
  // by replacing a connection that never became healthy.
  const checkConnections = () => {
    const now = Date.now();
    for (const [peerId, conn] of [...conns]) {
      if (!conn.initiator) continue;
      if (conn.pc.connectionState === 'connected') {
        conn.since = now;
      } else if (now - conn.since >= WATCHDOG_MS) {
        conn.pc.close();
        conns.delete(peerId);
        create(peerId, true);
      }
    }
  };

  const describe = (pc: RTCPeerConnection): SignalPayload => {
    const d = pc.localDescription as RTCSessionDescription;
    return { kind: 'description', description: { type: d.type, sdp: d.sdp } };
  };

  const localTrack = (kind: string) =>
    (kind === 'video' ? local?.getVideoTracks()[0] : local?.getAudioTracks()[0]) ?? null;

  /** Answerer: send our tracks on the transceivers the remote offer created. */
  async function attachTracks(conn: Conn) {
    conn.tracksAttached = true;
    for (const t of conn.pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      const track = localTrack(kind);
      if (!track || !local) continue;
      t.direction = 'sendrecv';
      await t.sender.replaceTrack(track);
      t.sender.setStreams?.(local);
      if (kind === 'video') {
        try {
          const params = t.sender.getParameters();
          if (params.encodings[0]) params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
          await t.sender.setParameters(params);
        } catch (err) {
          console.warn('could not cap video bitrate', err);
        }
      }
    }
  }

  async function applyDescription(
    peerId: string,
    conn: Conn,
    d: Extract<SignalPayload, { kind: 'description' }>['description']
  ): Promise<void> {
    const { pc } = conn;
    const collision = d.type === 'offer' && (conn.makingOffer || pc.signalingState !== 'stable');
    conn.ignoreOffer = !conn.polite && collision;
    if (conn.ignoreOffer) return;
    await pc.setRemoteDescription(d);
    if (d.type === 'offer') {
      conn.remoteFingerprint = fingerprintOf(d.sdp);
      if (!conn.tracksAttached) await attachTracks(conn);
      await pc.setLocalDescription();
      opts.sendSignal(peerId, describe(pc));
    }
  }

  function create(peerId: string, initiator: boolean): Conn {
    const pc = new Impl({ iceServers: opts.iceServers });
    const conn: Conn = {
      pc,
      polite: opts.selfId < peerId,
      makingOffer: false,
      ignoreOffer: false,
      tracksAttached: initiator,
      initiator,
      since: Date.now(),
      remoteFingerprint: null,
    };
    conns.set(peerId, conn);
    watchdog ??= setInterval(checkConnections, WATCHDOG_CHECK_MS);

    if (initiator) {
      // Video and audio share the local stream so the remote side sees one MediaStream.
      const video = localTrack('video');
      const audio = localTrack('audio');
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
    }

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
    // Only the initiator restarts ICE, so restarts never collide (see the module comment).
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && conn.initiator) pc.restartIce();
    };
    return conn;
  }

  return {
    connect(peerId) {
      // The smaller id waits for the other side's offer.
      if (!conns.has(peerId) && opts.selfId > peerId) create(peerId, true);
    },

    async handleSignal(from, payload) {
      let conn = conns.get(from);
      const isOffer = payload.kind === 'description' && payload.description.type === 'offer';
      // A new DTLS fingerprint means the initiator rebuilt its connection (watchdog). Chrome would
      // apply the offer to our old connection and then hang in "connecting", so start over too.
      if (conn && isOffer && !conn.initiator && conn.remoteFingerprint !== null) {
        const fingerprint = fingerprintOf(payload.description.sdp);
        if (fingerprint !== null && fingerprint !== conn.remoteFingerprint) {
          conn.pc.close();
          conns.delete(from);
          conn = undefined;
        }
      }
      if (!conn) {
        // Only a fresh offer may open a connection; stray candidates/answers are stale.
        if (!isOffer) return;
        conn = create(from, false);
      }
      try {
        if (payload.kind === 'description') {
          try {
            await applyDescription(from, conn, payload.description);
          } catch (err) {
            // A recreated initiator connection (new DTLS fingerprint) cannot be applied to our old
            // one: replace ours and answer afresh.
            if (payload.description.type !== 'offer' || conn.initiator) throw err;
            conn.pc.close();
            conns.delete(from);
            await applyDescription(from, create(from, false), payload.description);
          }
        } else {
          try {
            await conn.pc.addIceCandidate(payload.candidate ?? undefined);
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
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
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
