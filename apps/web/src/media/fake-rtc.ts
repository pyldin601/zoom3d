// Test double for RTCPeerConnection: records calls and lets tests drive negotiation events.
type Desc = { type: RTCSdpType; sdp: string };

export class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  static reset() {
    FakeRTCPeerConnection.instances = [];
  }

  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: Desc | null = null;
  remoteDescription: Desc | null = null;
  transceivers: { trackOrKind: unknown; init: RTCRtpTransceiverInit | undefined }[] = [];
  /** Transceivers created by applying a remote offer (answerer side). */
  remoteTransceivers: FakeTransceiver[] = [];
  tracks: unknown[] = [];
  calls: string[] = [];
  closed = false;
  restarts = 0;
  bytesReceived = 0;
  onnegotiationneeded: (() => unknown) | null = null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { streams: unknown[]; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(readonly config: RTCConfiguration) {
    FakeRTCPeerConnection.instances.push(this);
  }

  addTransceiver(trackOrKind: unknown, init?: RTCRtpTransceiverInit) {
    this.transceivers.push({ trackOrKind, init });
  }
  addTrack(track: unknown) {
    this.tracks.push(track);
  }
  async setLocalDescription(desc?: Desc) {
    const type = desc?.type ?? (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer');
    this.calls.push(`setLocal:${type}`);
    this.localDescription = { type, sdp: `fake-${type}` };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(desc: Desc) {
    this.calls.push(`setRemote:${desc.type}`);
    if (desc.type === 'offer' && this.remoteTransceivers.length === 0) {
      this.remoteTransceivers = [new FakeTransceiver('video'), new FakeTransceiver('audio')];
    }
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(candidate?: unknown) {
    this.calls.push('addIce');
    if (!this.remoteDescription && candidate) throw new Error('no remote description');
  }
  getTransceivers() {
    return this.remoteTransceivers;
  }
  restartIce() {
    this.restarts++;
  }
  close() {
    this.closed = true;
  }
  async getStats() {
    return new Map([['in', { type: 'inbound-rtp', bytesReceived: this.bytesReceived }]]);
  }

  // Test drivers
  fireNegotiationNeeded() {
    return this.onnegotiationneeded?.();
  }
  fireTrack(stream: unknown) {
    this.ontrack?.({ streams: [stream], track: {} });
  }
  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

export const asRTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

export class FakeTransceiver {
  direction: RTCRtpTransceiverDirection = 'recvonly';
  receiver: { track: { kind: string } };
  sender = {
    track: null as unknown,
    streams: [] as unknown[],
    parameters: { encodings: [{}] as RTCRtpEncodingParameters[] },
    async replaceTrack(track: unknown) {
      this.track = track;
    },
    setStreams(...streams: unknown[]) {
      this.streams = streams;
    },
    getParameters() {
      return this.parameters;
    },
    async setParameters(p: { encodings: RTCRtpEncodingParameters[] }) {
      this.parameters = p;
    },
  };
  constructor(kind: string) {
    this.receiver = { track: { kind } };
  }
}
