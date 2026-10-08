// Two-client signaling relay: assigns roles and forwards messages verbatim to the other client.
const msg = (obj) => JSON.stringify(obj);

export function createRelay() {
  const clients = [];
  const alive = new WeakMap();

  function add(socket) {
    if (clients.length >= 2) {
      socket.close(4000, 'full');
      return;
    }
    clients.push(socket);
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
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

  // Call periodically: drops clients that missed the previous ping (e.g. a sleeping phone).
  function sweep() {
    for (const socket of [...clients]) {
      if (!alive.get(socket)) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }

  return { add, sweep, size: () => clients.length };
}
