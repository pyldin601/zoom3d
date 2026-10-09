// Serves (dev) and emits (build) MediaPipe's wasm runtime under /mediapipe/wasm/, straight from the installed
// @mediapipe/tasks-vision, so the files always match the library version and nothing loads from a CDN.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];
const PREFIX = '/mediapipe/wasm/';

// The package exports each runtime file by name.
const read = (name: string) => readFileSync(createRequire(import.meta.url).resolve(`@mediapipe/tasks-vision/${name}`));

export function mediapipeWasm(): Plugin {
  return {
    name: 'zoom3d-mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.startsWith(PREFIX) ? req.url.slice(PREFIX.length).split('?')[0] : null;
        if (!name || !FILES.includes(name)) {
          next();
          return;
        }
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(read(name));
      });
    },
    generateBundle() {
      for (const name of FILES) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/wasm/${name}`, source: read(name) });
      }
    },
  };
}
