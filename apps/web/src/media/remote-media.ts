// One hidden-but-playing <video> per remote peer. Kept in the DOM so Chrome decodes it and feeds
// the WebRTC audio into Web Audio; muted because the spatial engine plays the voice. The container
// must use visibility:hidden (see index.html): a visible playing video drops the page to 30 fps.
// Audio-only streams (a peer's voice, their boombox) get a muted <audio> for the same reason.
export interface RemoteMedia {
  attach(peerId: string, stream: MediaStream): HTMLVideoElement;
  attachAudio(key: string, stream: MediaStream): void;
  detach(key: string): void;
  detachAll(): void;
}

export function createRemoteMedia(container: HTMLElement): RemoteMedia {
  const videos = new Map<string, HTMLVideoElement>();
  const audios = new Map<string, HTMLAudioElement>();
  const doc = container.ownerDocument;

  const detach = (key: string) => {
    const el = videos.get(key) ?? audios.get(key);
    if (!el) {
      return;
    }
    el.srcObject = null;
    el.remove();
    videos.delete(key);
    audios.delete(key);
  };

  /** Creates the element for `key` once, then plays `stream` in it. */
  const playIn = <T extends HTMLMediaElement>(
    elements: Map<string, T>,
    key: string,
    create: () => T,
    stream: MediaStream
  ) => {
    let el = elements.get(key);
    if (!el) {
      el = create();
      el.autoplay = true;
      el.muted = true;
      el.dataset.peer = key;
      container.append(el);
      elements.set(key, el);
    }
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    el.play().catch((err) => console.warn('remote media play failed', key, err));
    return el;
  };

  const createVideo = () => {
    const video = doc.createElement('video');
    // iOS reads playsinline when play() runs.
    video.playsInline = true;
    return video;
  };

  return {
    attach: (peerId, stream) => playIn(videos, peerId, createVideo, stream),
    attachAudio(key, stream) {
      playIn(audios, key, () => doc.createElement('audio'), stream);
    },
    detach,
    detachAll() {
      for (const key of [...videos.keys(), ...audios.keys()]) {
        detach(key);
      }
    },
  };
}
