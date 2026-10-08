import { expect, test } from 'vitest';
import { AUDIO_CONSTRAINTS, captureLocalMedia, VIDEO_CONSTRAINTS } from './capture';

function fakeStream(kinds: { video: boolean; audio: boolean }) {
  return {
    getVideoTracks: () => (kinds.video ? [{ kind: 'video' }] : []),
    getAudioTracks: () => (kinds.audio ? [{ kind: 'audio' }] : []),
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
  expect(VIDEO_CONSTRAINTS).toEqual({
    width: 256,
    height: 256,
    aspectRatio: 1,
    frameRate: 24,
    resizeMode: 'crop-and-scale',
  });
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
  });
});

test('insecure context does not even ask', async () => {
  const { calls, getUserMedia } = fakeGetUserMedia({ video: true, audio: true });
  expect(await captureLocalMedia({ isSecureContext: false, getUserMedia })).toEqual({
    stream: null,
    cam: false,
    mic: false,
    problem: 'insecure',
  });
  expect(calls).toEqual([]);
});
