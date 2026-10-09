import { expect, test, vi } from 'vitest';
import { AUDIO_CONSTRAINTS, captureLocalMedia, VIDEO_CONSTRAINTS } from './capture';
import type { Framer } from './framer';

function fakeStream(kinds: { video: boolean; audio: boolean }) {
  return {
    getVideoTracks: () => (kinds.video ? [{ kind: 'video', id: 'raw' }] : []),
    getAudioTracks: () => (kinds.audio ? [{ kind: 'audio', id: 'mic' }] : []),
  } as unknown as MediaStream;
}

/** Grants a request only if every requested kind is allowed. */
function fakeGetUserMedia(allow: { video: boolean; audio: boolean }) {
  const calls: MediaStreamConstraints[] = [];
  const getUserMedia = async (c: MediaStreamConstraints) => {
    calls.push(c);
    const wantsVideo = !!c.video;
    const wantsAudio = !!c.audio;
    if ((wantsVideo && !allow.video) || (wantsAudio && !allow.audio)) {
      throw new DOMException('denied', 'NotAllowedError');
    }
    return fakeStream({ video: wantsVideo, audio: wantsAudio });
  };
  return { calls, getUserMedia };
}

test('constraints match the spec', () => {
  expect(VIDEO_CONSTRAINTS).toEqual({ width: 640, height: 480, frameRate: 24 });
  expect(AUDIO_CONSTRAINTS).toEqual({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
});

test('everything allowed: one request for both', async () => {
  const { calls, getUserMedia } = fakeGetUserMedia({ video: true, audio: true });
  const local = await captureLocalMedia({ isSecureContext: true, getUserMedia });
  expect(calls).toEqual([{ video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS }]);
  expect(local).toMatchObject({ cam: true, mic: true, problem: null });
  expect(local.stream).not.toBeNull();
});

test('camera denied falls back to audio only', async () => {
  const { calls, getUserMedia } = fakeGetUserMedia({ video: false, audio: true });
  const local = await captureLocalMedia({ isSecureContext: true, getUserMedia });
  expect(calls[1]).toEqual({ audio: AUDIO_CONSTRAINTS });
  expect(local).toMatchObject({ cam: false, mic: true, problem: 'no-camera' });
});

test('mic denied falls back to video only', async () => {
  const { calls, getUserMedia } = fakeGetUserMedia({ video: true, audio: false });
  const local = await captureLocalMedia({ isSecureContext: true, getUserMedia });
  expect(calls).toHaveLength(3);
  expect(calls[2]).toEqual({ video: VIDEO_CONSTRAINTS });
  expect(local).toMatchObject({ cam: true, mic: false, problem: 'no-mic' });
});

test('nothing available still joins, with no stream', async () => {
  const { getUserMedia } = fakeGetUserMedia({ video: false, audio: false });
  expect(await captureLocalMedia({ isSecureContext: true, getUserMedia })).toEqual({
    stream: null,
    cam: false,
    mic: false,
    problem: 'none-available',
    framer: null,
  });
});

test('insecure context does not even ask', async () => {
  const { calls, getUserMedia } = fakeGetUserMedia({ video: true, audio: true });
  expect(await captureLocalMedia({ isSecureContext: false, getUserMedia })).toEqual({
    stream: null,
    cam: false,
    mic: false,
    problem: 'insecure',
    framer: null,
  });
  expect(calls).toEqual([]);
});

const fakeFramer = (raw: unknown) => ({ track: { kind: 'video', id: 'framed' }, rawTrack: raw }) as unknown as Framer;

test('a camera is framed: the stream carries the framed track and the original audio', async () => {
  const { getUserMedia } = fakeGetUserMedia({ video: true, audio: true });
  const frame = vi.fn(fakeFramer);
  const local = await captureLocalMedia({
    isSecureContext: true,
    getUserMedia,
    frame,
    createStream: (tracks) => ({ tracks }) as unknown as MediaStream,
  });
  expect(frame).toHaveBeenCalledWith({ kind: 'video', id: 'raw' });
  expect(local.framer).toBe(frame.mock.results[0]?.value);
  expect((local.stream as unknown as { tracks: unknown[] }).tracks).toEqual([
    { kind: 'video', id: 'framed' },
    { kind: 'audio', id: 'mic' },
  ]);
});

test('no camera, no framer', async () => {
  const { getUserMedia } = fakeGetUserMedia({ video: false, audio: true });
  const frame = vi.fn(fakeFramer);
  const local = await captureLocalMedia({ isSecureContext: true, getUserMedia, frame });
  expect(frame).not.toHaveBeenCalled();
  expect(local.framer).toBeNull();
});

test('a framer that fails to start leaves the raw camera stream in place', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { calls, getUserMedia } = fakeGetUserMedia({ video: true, audio: true });
  const local = await captureLocalMedia({
    isSecureContext: true,
    getUserMedia,
    frame: () => {
      throw new Error('no captureStream');
    },
  });
  expect(calls).toHaveLength(1);
  expect(local).toMatchObject({ cam: true, mic: true, problem: null, framer: null });
  expect(local.stream?.getVideoTracks()).toEqual([{ kind: 'video', id: 'raw' }]);
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});
