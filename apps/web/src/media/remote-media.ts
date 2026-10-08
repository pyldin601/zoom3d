// One hidden-but-playing <video> per remote peer. Kept in the DOM so Chrome decodes it;
// in M3 it also plays the remote audio (M4 mutes it and routes audio through Web Audio).
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
