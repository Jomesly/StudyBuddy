import { test, expect } from '@playwright/test';

test('Python preview renders continuously and stops streaming when hidden or switched off', async ({ page }) => {
  // Simulate a 30 FPS stream with valid JPEGs. No physical camera is opened.
  await page.addInitScript(() => {
    window.previewStats = { requests: 0, stopped: 0, rendered: 0 };
    window.previewHidden = false;
    Object.defineProperty(document, 'hidden', { get: () => window.previewHidden });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      if (String(input) !== '/api/stream') return originalFetch(input, options);
      window.previewStats.requests++;
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#72847a'; ctx.fillRect(0, 0, 640, 480);
      const jpeg = Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]), c => c.charCodeAt(0));
      const frame = new Uint8Array(4 + jpeg.length);
      new DataView(frame.buffer).setUint32(0, jpeg.length); frame.set(jpeg, 4);
      let timer, ended = false;
      const stop = () => {
        if (ended) return;
        ended = true; clearInterval(timer); window.previewStats.stopped++;
      };
      return new Response(new ReadableStream({
        start(controller) {
          timer = setInterval(() => controller.enqueue(frame), 1000 / 30);
          options.signal.addEventListener('abort', () => { stop(); controller.error(new DOMException('Aborted', 'AbortError')); }, { once: true });
        },
        cancel: stop,
      }));
    };
    document.addEventListener('load', e => {
      if (e.target.id === 'native-camera-image') window.previewStats.rendered++;
    }, true);
  });
  let state = { busy: false, phase: 'idle', cameraState: 'off', options: {}, app: {},
    reason: 'checking', sample: null, cameraFps: 30 };
  await page.route('**/api/health', r => r.fulfill({ json: { service: 'studybuddy-python', protocol: 1, key: 'test-key' } }));
  await page.route('**/api/cameras', r => r.fulfill({ json: { cameras: [{ index: 0, name: 'Test Camera' }] } }));
  await page.route('**/api/state', r => r.fulfill({ json: state }));
  await page.route('**/api/control', async r => {
    const body = r.request().postDataJSON();
    if (body.action === 'preview') state = { ...state, phase: 'preview', cameraState: 'on' };
    if (body.action === 'camera' || body.action === 'pause') state = { ...state, phase: 'idle', cameraState: 'off' };
    await r.fulfill({ json: state });
  });
  await page.goto('/');
  await expect(page.getByLabel('Camera device')).toHaveValue('0');
  await expect(page.locator('#camera-fps')).toContainText('30 FPS');
  await expect.poll(() => page.evaluate(() => window.previewStats.rendered), { timeout: 3000 }).toBeGreaterThan(35);
  expect(await page.evaluate(() => window.previewStats.requests)).toBe(1);
  await page.getByText('Camera preview & details', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.previewStats.stopped)).toBe(1);
  await expect(page.locator('#native-camera-image')).not.toHaveAttribute('src');
  await page.getByText('Camera preview & details', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.previewStats.requests)).toBe(2);
  await page.evaluate(() => { window.previewHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => page.evaluate(() => window.previewStats.stopped)).toBe(2);
  await page.evaluate(() => { window.previewHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => page.evaluate(() => window.previewStats.requests)).toBe(3);
  await page.getByRole('button', { name: 'Turn camera off', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.previewStats.stopped)).toBe(3);
});
