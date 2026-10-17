// Following a <video>'s frames: requestVideoFrameCallback where the browser has it, else polling.

export type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** Without requestVideoFrameCallback, poll once per 24 fps frame. */
export const VIDEO_POLL_MS = 42;
