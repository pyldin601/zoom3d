// The media seam: call.ts only talks to this. Implemented over the LiveKit SFU by livekit.ts (LiveKit spec §4).
import type { LiveKitAccess } from '@zoom3d/shared';

export interface TransportOptions extends LiveKitAccess {
  localStream: MediaStream | null;
  /** A peer's face and voice; called again with a new stream whenever its tracks change. */
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  onRemoteBoombox: (peerId: string, stream: MediaStream) => void;
}

export interface MediaTransport {
  connect(peerId: string): void;
  disconnect(peerId: string): void;
  close(): void;
  /** The latest LiveKit access from the game (a fresh token on every welcome), used for the next connect. */
  setAccess(access: LiveKitAccess): void;
  stats(peerId: string): Promise<{ bytesReceived: number; boomboxBytesReceived: number } | null>;
  /** Sends `track` as our face (the framer's canvas, or the raw camera while the tab is hidden). */
  setVideoTrack(track: MediaStreamTrack): void;
  /** Swaps the mic, e.g. after a headset was unplugged. */
  setAudioTrack(track: MediaStreamTrack): void;
  /** Sends `track` as our boombox music, or nothing. */
  setBoomboxTrack(track: MediaStreamTrack | null): void;
}
