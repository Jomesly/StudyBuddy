import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'vite';

test('the web watcher ignores Python environments but still watches application files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studybuddy-watch-'));
  let server;
  try {
    for (const dir of ['src', 'venv/Lib/site-packages', '.venv-web/lib', 'backend/__pycache__']) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, 'fixture.js'), 'export default 1;');
    }
    await writeFile(join(root, 'index.html'), '<script type="module" src="/src/fixture.js"></script>');
    server = await createServer({ root, configFile: resolve('vite.config.js'), server: { port: 0 }, optimizeDeps: { noDiscovery: true } });
    server.watcher.add(root);
    await once(server.watcher, 'ready');
    for (let i = 0; i < 100 && !Object.keys(server.watcher.getWatched()).some(p => p.replaceAll('\\', '/').endsWith('/src')); i++) await setTimeout(20);
    const watched = server.watcher.getWatched();
    assert.ok(Object.keys(watched).some(p => p.replaceAll('\\', '/').endsWith('/src')), `App source must stay watched: ${JSON.stringify(watched)}`);
    assert.equal(Object.keys(watched).some(p => /[\\/](venv|\.venv-web|__pycache__)([\\/]|$)/.test(p)), false,
      'Python dependency and cache folders must not overload the web watcher');
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
