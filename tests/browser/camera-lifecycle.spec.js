import { test, expect } from '@playwright/test';

async function nativeCamera(page, cameras = [{ index: 0, name: 'Camera A' }, { index: 1, name: 'Camera B' }]) {
  // Keep the real UI, JPEG decoder, and stream lifecycle; only replace hardware/API I/O.
  await page.addInitScript(() => {
    const original = fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      if (String(input) !== '/api/stream') return original(input, options);
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]), c => c.charCodeAt(0));
      const frame = new Uint8Array(bytes.length + 4);
      new DataView(frame.buffer).setUint32(0, bytes.length); frame.set(bytes, 4);
      let timer;
      return new Response(new ReadableStream({
        start(controller) {
          timer = setInterval(() => controller.enqueue(frame), 33);
          options.signal.addEventListener('abort', () => { clearInterval(timer); controller.error(new DOMException('Aborted', 'AbortError')); }, { once: true });
        },
        cancel() { clearInterval(timer); },
      }));
    };
  });
  let state = { busy: false, sessionId: null, phase: 'idle', cameraState: 'off', cameraError: null, app: {},
    reason: 'checking', sample: null, options: { camera: false, cameraIndex: 0 }, observations: {} };
  const controls = [];
  let restarted = false;
  let previewGate;
  await page.route('**/api/health', r => r.fulfill({ json: { service: 'studybuddy-python', protocol: 1, key: 'test-key' } }));
  await page.route('**/api/cameras', r => r.fulfill({ json: { cameras, selected: state.options.cameraIndex } }));
  await page.route('**/api/state', r => {
    if (restarted) { restarted = false; return r.fulfill({ status: 503, json: { detail: 'Engine restarting' } }); }
    return r.fulfill({ json: state });
  });
  await page.route('**/api/control', async r => {
    const body = r.request().postDataJSON(); controls.push(body);
    if (body.action === 'preview' && previewGate) await previewGate;
    if (body.action === 'preview' || body.action === 'camera') {
      const camera = body.action === 'preview' || body.camera;
      state = { ...state, phase: camera ? 'preview' : 'idle', cameraState: camera ? 'on' : 'off',
        options: { ...state.options, camera, cameraIndex: body.cameraIndex ?? state.options.cameraIndex } };
    }
    if (body.action === 'end') state = { ...state, phase: 'idle', cameraState: 'off' };
    await r.fulfill({ json: state });
  });
  return { controls, loading() { state = { ...state, cameraState: 'loading' }; },
    restart() { state = { ...state, phase: 'idle', cameraState: 'off' }; restarted = true; },
    holdPreview() { let release; previewGate = new Promise(resolve => { release = resolve; }); return release; } };
}

async function expectFrame(page) {
  await expect(page.locator('#native-camera-image')).toBeVisible();
  await expect.poll(() => page.locator('#native-camera-image').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
}

test('a fresh page shows the preview when its camera switch is enabled', async ({ page }) => {
  await nativeCamera(page);
  await page.goto('/');
  await expect(page.locator('#camera')).toBeChecked();
  await expectFrame(page);
});

test('the camera switch enables preview again after turning it off', async ({ page }) => {
  await nativeCamera(page);
  await page.goto('/');
  await expect(page.getByLabel('Camera device')).toHaveValue('0');
  await page.locator('#monitoring-title').click();
  await page.locator('#camera').uncheck();
  await page.locator('#camera').check();
  await expectFrame(page);
  await page.locator('#camera').uncheck();
  await expect(page.locator('#native-camera-image')).not.toHaveAttribute('src');
  await expect(page.locator('#camera-placeholder')).toBeVisible();
});

test('a camera selection during startup enables the newly selected device', async ({ page }) => {
  const api = await nativeCamera(page);
  await page.goto('/');
  await expect(page.getByLabel('Camera device')).toHaveValue('0');
  // Works before the fix too: explicitly opening preview is its only working idle path.
  if (await page.getByRole('button', { name: 'Enable camera', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Enable camera', exact: true }).click();
  }
  api.loading();
  await expect(page.locator('#camera-chip')).toHaveText('Starting');
  await page.getByLabel('Camera device').selectOption('1');
  await expect.poll(() => api.controls.at(-1)).toMatchObject({ cameraIndex: 1, camera: true });
  await expectFrame(page);
});

test('the Python camera panel clearly reports a missing device', async ({ page }) => {
  await nativeCamera(page, []);
  await page.goto('/');
  await expect(page.locator('#engine-chip')).toHaveText('Python engine connected');
  await expect(page.locator('#camera-message')).toContainText('No camera found');
  await expect(page.locator('#camera-placeholder')).toBeVisible();
  await expect(page.locator('#native-camera-image')).not.toHaveAttribute('src');
});

test('switching back to Python starts its enabled preview', async ({ page }) => {
  await nativeCamera(page);
  await page.goto('/');
  await expectFrame(page);
  await page.locator('#monitoring-title').click();
  await page.getByLabel('Detection engine').selectOption('browser');
  await page.getByLabel('Detection engine').selectOption('python');
  await expect(page.locator('#camera')).toBeChecked();
  await expectFrame(page);
});

test('reconnecting to a restarted engine restores an enabled preview', async ({ page }) => {
  const api = await nativeCamera(page);
  await page.goto('/');
  await expectFrame(page);
  const before = api.controls.length;
  api.restart();
  await expect.poll(() => api.controls.length, { timeout: 8000 }).toBeGreaterThan(before);
  await expectFrame(page);
});

test('changing engine while camera enable is pending releases Python capture', async ({ page }) => {
  const api = await nativeCamera(page);
  const release = api.holdPreview();
  await page.goto('/');
  await expect.poll(() => api.controls.some(c => c.action === 'preview')).toBe(true);
  await page.locator('#monitoring-title').click();
  await page.getByLabel('Detection engine').selectOption('browser');
  release();
  await expect.poll(() => api.controls.at(-1)?.action).toBe('end');
  await expect(page.locator('#engine-chip')).toHaveText('Browser-only mode');
  await expect(page.locator('#native-camera-image')).not.toHaveAttribute('src');
});
