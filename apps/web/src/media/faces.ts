// Per-peer face textures (FACE_SIZE² texels, packed like rgb()) from live video, else the peer's
// avatar picture, else an initials disc.
import { createFaceHistory, type FaceHistory } from './face-history';
import { type FrameVideo, VIDEO_POLL_MS } from './video-frames';

export const FACE_SIZE = 256;
export const FACE_STALL_MS = 2000;
/** Light later than this is still within the frame on show: the live face is what it shows (D41). */
const ONE_FRAME_MS = 34;
/** Avatars are AVATAR_SIZE_PX²; anything much larger is a hostile decode bomb and is never drawn. */
export const AVATAR_MAX_DIM = 512;

export function squareCrop(w: number, h: number): { sx: number; sy: number; size: number } {
  const size = Math.min(w, h);
  return { sx: Math.floor((w - size) / 2), sy: Math.floor((h - size) / 2), size };
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => ([...w][0] ?? '').toUpperCase())
      .join('') || '?'
  );
}

export interface FaceSource {
  /** Live video texels; the avatar picture or initials disc when the camera is off, missing or stalled. */
  readonly texels: Uint32Array;
  live(): boolean;
  update(now: number): void;
  /** A new element or stream keeps showing the last frame until its own first frame (or the stall). */
  setVideo(video: HTMLVideoElement | null): void;
  setCam(on: boolean): void;
  /** Video is off on purpose (out of sight, 6c spec §4.4): keep showing the last live frame, however old. */
  setPaused(paused: boolean): void;
  /** Keeps its last seconds of video while slow light is on (D41); off, the history and its memory go. */
  history(on: boolean): void;
  /**
   * What the face showed `lateMs` ago: its live texels within a frame or without a history, else a smaller stored
   * frame, or the avatar or initials where it showed no video then. Any square size: read it by its length.
   */
  seen(lateMs: number): Uint32Array;
  dispose(): void;
}

export interface FaceOptions {
  name: string;
  color: string;
  document: Document;
  /** Validated JPEG data URL; replaces the initials disc once it decodes. */
  avatar?: string | null;
  createImage?: () => HTMLImageElement;
}

export function createFace(opts: FaceOptions): FaceSource {
  const ctx = faceCanvas(opts.document);
  const readTexels = () => new Uint32Array(ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE).data.buffer.slice(0));
  drawInitials(ctx, opts.name, opts.color);
  let fallbackTexels = readTexels();
  // Reused for every frame: no per-frame texture allocation beyond what getImageData itself does.
  const liveTexels = new Uint32Array(FACE_SIZE * FACE_SIZE);

  let video: FrameVideo | null = null;
  let frameHandle: number | null = null;
  let camOn = true;
  let lastFrameAt: number | null = null;
  /** Whether liveTexels holds a frame at all. */
  let hasFrame = false;
  /** When the current video was set: the last frame is held for FACE_STALL_MS from then. */
  let videoSetAt = Number.NEGATIVE_INFINITY;
  let paused = false;
  /** The polled video's currentTime last copied; null before the first. */
  let lastVideoTime: number | null = null;
  let lastPollAt = Number.NEGATIVE_INFINITY;
  let now = 0;
  let disposed = false;
  let history: FaceHistory | null = null;

  const showAvatarOnceLoaded = (src: string) => {
    const img = opts.createImage?.() ?? new Image();
    img.onload = () => {
      if (disposed || img.naturalWidth > AVATAR_MAX_DIM || img.naturalHeight > AVATAR_MAX_DIM) {
        return;
      }
      const { sx, sy, size } = squareCrop(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, sx, sy, size, size, 0, 0, FACE_SIZE, FACE_SIZE);
      fallbackTexels = readTexels();
    };
    img.src = src;
  };
  if (opts.avatar) {
    showAvatarOnceLoaded(opts.avatar);
  }

  const copyVideoFrame = (at: number) => {
    // A disabled camera still delivers black frames; they are never shown, so skip the work.
    if (!camOn || !video || video.videoWidth === 0) {
      return;
    }
    const { sx, sy, size } = squareCrop(video.videoWidth, video.videoHeight);
    ctx.drawImage(video, sx, sy, size, size, 0, 0, FACE_SIZE, FACE_SIZE);
    const { data } = ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
    liveTexels.set(new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4));
    lastFrameAt = at;
    hasFrame = true;
    history?.record(at, liveTexels);
  };

  const onFrame = (at: number) => {
    copyVideoFrame(at);
    if (video?.requestVideoFrameCallback) {
      frameHandle = video.requestVideoFrameCallback(onFrame);
    }
  };

  const stopFrames = () => {
    if (video && frameHandle !== null) {
      video.cancelVideoFrameCallback?.(frameHandle);
    }
    frameHandle = null;
  };

  const isLive = () => camOn && video !== null && lastFrameAt !== null && now - lastFrameAt < FACE_STALL_MS;
  const holdLast = () => camOn && hasFrame && (paused || now - videoSetAt < FACE_STALL_MS);

  return {
    get texels() {
      return isLive() || holdLast() ? liveTexels : fallbackTexels;
    },
    live: isLive,
    update(at) {
      now = at;
      history?.mark(at, isLive() || holdLast());
      // Without requestVideoFrameCallback, poll and only count frames whose timestamp moved.
      if (video && !video.requestVideoFrameCallback && at - lastPollAt >= VIDEO_POLL_MS) {
        lastPollAt = at;
        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          copyVideoFrame(at);
        }
      }
    },
    setVideo(v) {
      stopFrames();
      video = v as FrameVideo | null;
      lastFrameAt = null;
      videoSetAt = now;
      lastVideoTime = null;
      lastPollAt = Number.NEGATIVE_INFINITY;
      if (video?.requestVideoFrameCallback) {
        frameHandle = video.requestVideoFrameCallback(onFrame);
      }
    },
    setCam(on) {
      camOn = on;
    },
    setPaused(p) {
      // Resuming: the video comes back a moment later, so hold the last frame as for a new video.
      if (paused && !p) {
        videoSetAt = now;
      }
      paused = p;
    },
    history(on) {
      if (!on) {
        history = null;
      } else {
        history ??= createFaceHistory();
      }
    },
    seen(lateMs) {
      const shown = isLive() || holdLast() ? liveTexels : fallbackTexels;
      if (history === null || history.empty || lateMs < ONE_FRAME_MS) {
        return shown;
      }
      return history.at(now - lateMs) ?? fallbackTexels;
    },
    dispose() {
      disposed = true;
      stopFrames();
      video = null;
    },
  };
}

function faceCanvas(doc: Document): CanvasRenderingContext2D {
  const canvas = doc.createElement('canvas');
  canvas.width = FACE_SIZE;
  canvas.height = FACE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('a canvas without a 2d context');
  }
  return ctx;
}

function drawInitials(ctx: CanvasRenderingContext2D, name: string, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(FACE_SIZE * 0.45)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(name), FACE_SIZE / 2, FACE_SIZE / 2 + FACE_SIZE * 0.03);
}
