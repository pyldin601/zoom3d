// The media seam: call.ts only talks to this. Implemented over the LiveKit SFU by livekit.ts (LiveKit spec §4).
import type { LiveKitAccess } from '@zoom3d/shared';
import type { Want } from './interest';

/** Our face in three sizes (6c spec §3), each its own track: the framer's canvases, or the raw camera while hidden. */
export interface FaceTracks {
  256: MediaStreamTrack;
  128: MediaStreamTrack;
  64: MediaStreamTrack;
}

export interface TransportOptions extends LiveKitAccess {
  localStream: MediaStream | null;
  /** A peer's shown face (video only); a new stream whenever it changes (another size), empty when off. */
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  /** A peer's voice (mic only), separate so face changes never touch it; a new stream when the mic changes, empty
   * when it goes. */
  onRemoteVoice: (peerId: string, stream: MediaStream) => void;
  onRemoteBoombox: (peerId: string, stream: MediaStream) => void;
}

export interface MediaTransport {
  close(): void;
  /** The latest LiveKit access from the game (a fresh token on every welcome), used for the next connect. */
  setAccess(access: LiveKitAccess): void;
  stats(peerId: string): Promise<{ bytesReceived: number; boomboxBytesReceived: number } | null>;
  /** Sends our face in its three sizes (the framer's canvases, or the raw camera while the tab is hidden). */
  setVideoTracks(tracks: FaceTracks): void;
  /** Whether the peer publishes anything in the media room (bots never do). */
  publishes(peerId: string): boolean;
  /** Subscribes to a peer's face (at that size) and voice as wanted; nothing is received until asked for. */
  setWanted(peerId: string, want: Want): void;
  /** Swaps the mic, e.g. after a headset was unplugged. */
  setAudioTrack(track: MediaStreamTrack): void;
  /** Sends `track` as our boombox music, or nothing. */
  setBoomboxTrack(track: MediaStreamTrack | null): void;
}
