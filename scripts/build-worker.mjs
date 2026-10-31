import { build } from 'esbuild';

// MediaPipe loads its WASM runtime with importScripts, so use a classic worker.
await build({
  entryPoints: ['src/vision-worker.js'],
  outfile: 'public/vision-worker.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110', 'firefox115', 'safari17'],
  minify: true,
  legalComments: 'eof',
});
