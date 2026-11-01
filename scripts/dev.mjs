import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const windows = process.platform === 'win32';
const isPython311 = executable => {
  if (!existsSync(executable)) return false;
  const result = spawnSync(executable, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 && result.stdout.trim() === '3.11';
};
let python = resolve(windows ? 'venv/Scripts/python.exe' : 'venv/bin/python');
if (!isPython311(python)) {
  python = resolve(windows ? '.venv-web/Scripts/python.exe' : '.venv-web/bin/python');
  if (!existsSync(python)) {
    console.log('Preparing the Python 3.11 detection environment…');
    const result = spawnSync(windows ? 'py' : 'python3', [...(windows ? ['-3.11'] : []), '-m', 'venv', '.venv-web'], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error('Python 3.11 is required for the original engine. Install it, then run npm run dev again.');
  }
}
if (!isPython311(python)) {
  throw new Error(`The environment at ${python} needs Python 3.11. Rename .venv-web to keep a backup, then rerun npm run dev with Python 3.11 installed.`);
}
const check = () => spawnSync(python, ['-m', 'backend.check_runtime'], { encoding: 'utf8', windowsHide: true,
  env: { ...process.env, PYGAME_HIDE_SUPPORT_PROMPT: '1' } });
const probe = check();
if (probe.status !== 0) {
  console.log('Installing the original Python detection dependencies (first run may take a few minutes)…');
  const install = spawnSync(python, ['-m', 'pip', 'install', '-r', 'requirements.txt'], { stdio: 'inherit', windowsHide: true });
  if (install.status !== 0) throw new Error('Python setup failed. Review the installation error above.');
  const verified = check();
  if (verified.status !== 0) throw new Error(verified.stderr || 'The detector could not import its dependencies. Recreate the Python 3.11 environment and retry.');
}

let backend, server;
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  await server?.close();
  backend?.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('exit', () => backend?.kill());
try {
  // Let Vite check its own port before starting another background service.
  server = await createServer();
  await server.listen();
  const existing = await fetch('http://127.0.0.1:8766/api/health', { signal: AbortSignal.timeout(600) }).catch(() => null);
  if (existing) throw new Error('Port 8766 is already in use. Stop the other StudyBuddy engine terminal before starting this one.');
  backend = spawn(python, ['-m', 'backend.server'], { cwd: process.cwd(), stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYGAME_HIDE_SUPPORT_PROMPT: '1' } });
  backend.on('error', error => { console.error(`Could not start the Python engine: ${error.message}`); void shutdown(1); });
  backend.on('exit', code => { if (!stopping) { console.error('Python detection engine stopped.'); void shutdown(code || 1); } });
  let ready = false;
  const healthUrl = new URL('/api/health', server.resolvedUrls.local[0]);
  for (let i = 0; i < 100 && !stopping; i++) {
    // Readiness must cover the same Vite proxy path that the browser uses.
    const direct = await fetch('http://127.0.0.1:8766/api/health', { signal: AbortSignal.timeout(500) }).catch(() => null);
    const health = direct?.ok ? await direct.json() : null;
    const response = health?.service === 'studybuddy-python'
      ? await fetch(healthUrl, { signal: AbortSignal.timeout(500) }).catch(() => null) : null;
    if (response?.ok && (await response.json()).service === 'studybuddy-python') { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('The engine did not become reachable through the web server. Review the Python and Vite errors above.');
  console.log('\nStudyBuddy: browser + original Python detection ready.');
  server.printUrls();
  console.log('Camera and active-window monitoring begin only when enabled in the page. Ctrl+C stops both services.');
} catch (error) {
  console.error(error.message);
  await shutdown(1);
}
