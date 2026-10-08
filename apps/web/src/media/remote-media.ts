// One hidden-but-playing <video> per remote peer. Kept in the DOM so Chrome decodes it and feeds
// the WebRTC audio into Web Audio; muted because the spatial engine plays the voice. The container
// must use visibility:hidden (see index.html): a visible playing video drops the page to 30 fps.
export interface RemoteMedia {
  attach(peerId: string, stream: MediaStream): HTMLVideoElement;
  detach(peerId: string): void;
  detachAll(): void;
}

export function createRemoteMedia(container: HTMLElement): RemoteMedia {
  const elements = new Map<string, HTMLVideoElement>();
  const detach = (peerId: string) => {
    const el = elements.get(peerId);
    if (!el) return;
    el.srcObject = null;
    el.remove();
    elements.delete(peerId);
  };
  return {
    attach(peerId, stream) {
      let el = elements.get(peerId);
      if (!el) {
        el = container.ownerDocument.createElement('video');
        el.autoplay = true;
        el.playsInline = true;
        el.muted = true;
        el.dataset.peer = peerId;
        container.append(el);
        elements.set(peerId, el);
      }
      if (el.srcObject !== stream) el.srcObject = stream;
      el.play().catch((err) => console.warn('remote media play failed', peerId, err));
      return el;
    },
    detach,
    detachAll() {
      for (const id of [...elements.keys()]) detach(id);
    },
  };
}
