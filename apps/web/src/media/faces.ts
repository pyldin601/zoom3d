// Per-peer face textures (FACE_SIZE² texels, packed like rgb()) from live video, or an initials disc.
export const FACE_SIZE = 128;
export const FACE_STALL_MS = 2000;
const POLL_MS = 66;

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
  /** Live video texels, or the initials disc when the camera is off, missing or stalled. */
  readonly texels: Uint32Array;
  live(): boolean;
  update(now: number): void;
  setVideo(video: HTMLVideoElement | null): void;
  setCam(on: boolean): void;
  dispose(): void;
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function createFace(opts: { name: string; color: string; document: Document }): FaceSource {
  const canvas = opts.document.createElement('canvas');
  canvas.width = FACE_SIZE;
  canvas.height = FACE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const read = () => new Uint32Array(ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE).data.buffer.slice(0));

  ctx.fillStyle = opts.color;
  ctx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(FACE_SIZE * 0.45)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(opts.name), FACE_SIZE / 2, FACE_SIZE / 2 + FACE_SIZE * 0.03);
  const initialsTexels = read();
  let liveTexels = new Uint32Array(FACE_SIZE * FACE_SIZE);

  let video: FrameVideo | null = null;
  let frameHandle: number | null = null;
  let camOn = true;
  let lastFrameAt: number | null = null;
  let lastVideoTime = -1;
  let lastPollAt = Number.NEGATIVE_INFINITY;
  let now = 0;

  const grab = (at: number) => {
    if (!video || video.videoWidth === 0) return;
    const { sx, sy, size } = squareCrop(video.videoWidth, video.videoHeight);
    ctx.drawImage(video, sx, sy, size, size, 0, 0, FACE_SIZE, FACE_SIZE);
    liveTexels = read();
    lastFrameAt = at;
  };

  const onFrame = (at: number) => {
    grab(at);
    if (video?.requestVideoFrameCallback) frameHandle = video.requestVideoFrameCallback(onFrame);
  };

  const stopFrames = () => {
    if (video && frameHandle !== null) video.cancelVideoFrameCallback?.(frameHandle);
    frameHandle = null;
  };

  const isLive = () => camOn && video !== null && lastFrameAt !== null && now - lastFrameAt < FACE_STALL_MS;

  return {
    get texels() {
      return isLive() ? liveTexels : initialsTexels;
    },
    live: isLive,
    update(at) {
      now = at;
      // Without requestVideoFrameCallback, poll and only count frames whose timestamp moved.
      if (video && !video.requestVideoFrameCallback && at - lastPollAt >= POLL_MS) {
        lastPollAt = at;
        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          grab(at);
        }
      }
    },
    setVideo(v) {
      stopFrames();
      video = v as FrameVideo | null;
      lastFrameAt = null;
      lastVideoTime = -1;
      lastPollAt = Number.NEGATIVE_INFINITY;
      if (video?.requestVideoFrameCallback) frameHandle = video.requestVideoFrameCallback(onFrame);
    },
    setCam(on) {
      camOn = on;
    },
    dispose() {
      stopFrames();
      video = null;
    },
  };
}
