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
  const play = <T extends HTMLMediaElement>(key: string, tag: 'video' | 'audio', stream: MediaStream): T => {
    let el = elements.get(key) as T | undefined;
    if (!el) {
      el = container.ownerDocument.createElement(tag) as unknown as T;
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
  return {
    attach(peerId, stream) {
      const el = play<HTMLVideoElement>(peerId, 'video', stream);
      el.playsInline = true;
      return el;
    },
    attachAudio(key, stream) {
      play(key, 'audio', stream);
    },
    detach,
    detachAll() {
      for (const id of [...elements.keys()]) {
        detach(id);
      }
    },
  };
}
