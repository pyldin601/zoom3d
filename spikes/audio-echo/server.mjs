import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRelay } from './relay.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(here, 'public');
const port = Number(process.env.PORT ?? 8443);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(
  { key: await readFile(join(here, '.cert/key.pem')), cert: await readFile(join(here, '.cert/cert.pem')) },
  async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'https://x').pathname);
    const raw = req.url.split('?')[0];
    const file = normalize(join(publicDir, path === '/' ? 'index.html' : path));
    if (raw.includes('..') || !file.startsWith(publicDir + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  },
);

const relay = createRelay();
new WebSocketServer({ server, path: '/ws' }).on('connection', (socket) => relay.add(socket));

server.listen(port, '0.0.0.0', () => {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`https://${a.address}:${port}/`);
    }
  }
  console.log(`https://localhost:${port}/`);
});
