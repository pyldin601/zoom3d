// Bundles the spike into one HTML file: dist/raytrace.html (the page body, as published) and dist/index.html (the
// same with a document around it, for opening locally). Run from the repo root: node spikes/raytrace/build.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const esbuild = createRequire(`${root}apps/server/package.json`)('esbuild');

const result = await esbuild.build({
  entryPoints: [`${here}main.ts`],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  write: false,
  alias: { '@zoom3d/shared': `${root}packages/shared/src/index.ts` },
  logLevel: 'warning',
});
const script = `<script>${result.outputFiles[0].text}</script>`;
const page = readFileSync(`${here}page.html`, 'utf8').replace('<!--SCRIPT-->', () => script);
mkdirSync(`${here}dist`, { recursive: true });
writeFileSync(`${here}dist/raytrace.html`, page);
writeFileSync(
  `${here}dist/index.html`,
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<style>body{margin:0}</style></head><body>\n${page}\n</body></html>\n`
);
console.log(`dist/raytrace.html ${(page.length / 1024).toFixed(0)} KB`);
