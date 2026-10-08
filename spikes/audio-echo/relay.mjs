// Two-client signaling relay: assigns roles and forwards messages verbatim to the other client.
const msg = (obj) => JSON.stringify(obj);

export function createRelay() {
  const clients = [];

  function add(socket) {
    if (clients.length >= 2) {
      socket.close(4000, 'full');
      return;
    }
    clients.push(socket);
    const other = clients.find((c) => c !== socket);
    socket.send(msg({ type: 'role', role: other ? 'offer' : 'wait' }));
    if (other) other.send(msg({ type: 'peer-joined' }));

    socket.on('message', (data) => {
      const peer = clients.find((c) => c !== socket);
      if (peer) peer.send(String(data));
    });
    socket.on('close', () => {
      const i = clients.indexOf(socket);
      if (i === -1) return;
      clients.splice(i, 1);
      for (const c of clients) c.send(msg({ type: 'peer-left' }));
    });
  }

  return { add, size: () => clients.length };
}
