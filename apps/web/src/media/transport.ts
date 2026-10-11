// The media seam: call.ts only talks to this. Implemented by the LiveKit SFU transport (livekit.ts).
import type { SignalPayload } from '@zoom3d/shared';

export interface MediaTransport {
  connect(peerId: string): void;
  handleSignal(from: string, payload: SignalPayload): Promise<void>;
  disconnect(peerId: string): void;
  close(): void;
  stats(peerId: string): Promise<{ bytesReceived: number; boomboxBytesReceived: number } | null>;
  /** Sends `track` instead of the stream's video track, on current and future connections. */
  setVideoTrack(track: MediaStreamTrack): void;
  /** Swaps the mic on current connections; later ones read it from the local stream. */
  setAudioTrack(track: MediaStreamTrack): void;
  /** Sends `track` (or nothing) on the boombox transceiver, on current and future connections. */
  setBoomboxTrack(track: MediaStreamTrack | null): void;
}
