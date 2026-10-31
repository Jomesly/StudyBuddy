import { defineConfig } from 'vite';

export default defineConfig({
  // This checkout also contains Python packages and their HTML documentation.
  // They are neither web entry points nor files Vite needs to watch.
  optimizeDeps: { entries: ['index.html'] },
  server: {
    host: '127.0.0.1', port: 5174, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8766' },
    watch: { ignored: ['**/venv/**', '**/.venv/**', '**/.venv-web/**', '**/__pycache__/**', '**/yolov5/**', '**/public/wasm/**', '**/public/models/**'] },
  },
  preview: { port: 4173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8766' } },
  worker: { format: 'es' },
});
