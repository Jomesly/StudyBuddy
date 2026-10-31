import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeMonitor } from '../src/native-monitor.js';

test('an engine restart refreshes authorization without falsely reporting offline', async t => {
  const states = [], connections = [], requests = [];
  const monitor = new NativeMonitor({ onState: state => states.push(state), onConnection: ready => connections.push(ready) });
  monitor.ready = true; monitor.key = 'previous-engine-key';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    if (url === '/api/health') return Response.json({ service: 'studybuddy-python', protocol: 1, key: 'restarted-engine-key' });
    if (options.headers['X-StudyBuddy-Key'] !== 'restarted-engine-key') return Response.json({ detail: 'Local engine authorization required' }, { status: 403 });
    return Response.json({ phase: 'idle', cameraState: 'off' });
  });
  try {
    await monitor.poll();
    assert.equal(monitor.ready, true, 'A reachable restarted engine should remain connected');
    assert.equal(monitor.key, 'restarted-engine-key');
    assert.deepEqual(states, [{ phase: 'idle', cameraState: 'off' }]);
    assert.deepEqual(connections, [true]);
    assert.deepEqual(requests, ['/api/state', '/api/health', '/api/state']);
  } finally { clearTimeout(monitor.timer); }
});

test('the renamed interface connects to an engine already running during the update', async t => {
  const values = new Map([['focusbuddy.client', 'existing-browser-owner']]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ service: 'focusbuddy-python', protocol: 1, key: 'same-running-engine' }));
  const monitor = new NativeMonitor({ onConnection() {}, onState() {} });
  assert.equal(await monitor.connect(), true);
  assert.equal(monitor.client, 'existing-browser-owner');
  assert.equal(monitor.headers()['X-FocusBuddy-Client'], 'existing-browser-owner');
  assert.equal(values.get('studybuddy.client'), 'existing-browser-owner');
});
