// One hidden-but-playing <video> per remote peer. Kept in the DOM so Chrome decodes it and feeds
// the WebRTC audio into Web Audio; muted because the spatial engine plays the voice. The container
// must use visibility:hidden (see index.html): a visible playing video drops the page to 30 fps.
// Audio-only streams (a peer's boombox) get a muted <audio> for the same reason.
export interface RemoteMedia {
  attach(peerId: string, stream: MediaStream): HTMLVideoElement;
  attachAudio(key: string, stream: MediaStream): void;
  detach(key: string): void;
  detachAll(): void;
}

export function createRemoteMedia(container: HTMLElement): RemoteMedia {
  const elements = new Map<string, HTMLMediaElement>();
  const detach = (key: string) => {
    const el = elements.get(key);
    if (!el) {
      return;
    }
    el.srcObject = null;
    el.remove();
    elements.delete(key);
  };
  /** Creates (once) and plays the element for `key`; `el` is ready before play() runs. */
  const play = (key: string, el: HTMLMediaElement, stream: MediaStream) => {
    if (!elements.has(key)) {
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
  };
  const doc = container.ownerDocument;
  return {
    attach(peerId, stream) {
      const el = (elements.get(peerId) as HTMLVideoElement | undefined) ?? doc.createElement('video');
      // iOS reads playsinline when play() runs.
      el.playsInline = true;
      play(peerId, el, stream);
      return el;
    },
    attachAudio(key, stream) {
      play(key, elements.get(key) ?? doc.createElement('audio'), stream);
    },
    detach,
    detachAll() {
      for (const id of [...elements.keys()]) {
        detach(id);
      }
    },
  };
}
