import { test, expect } from '@playwright/test';

// Default Python preview now follows the enabled switch on page load. These
// browser-only tests must not open hardware before they select the fallback.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', r => r.fulfill({ status: 503, json: { detail: 'Python engine isolated in browser-only tests' } }));
});

// Browser-only flows must not drive the real Python engine (and its camera) when one is running.
async function open(page) {
  await page.goto('/');
  await page.locator('#monitoring-title').click();
  await page.getByLabel('Detection engine').selectOption('browser');
}

async function start(page, task = 'Read chapter four') {
  await page.getByLabel('What would you like to work on?').fill(task);
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
}

async function freezeClock(page) {
  const time = new Date('2026-11-01T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
}

test('timer, ongoing pause, history, reflection, and export work across reloads', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await freezeClock(page);
  await open(page);
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.locator('#task')).toBeFocused();
  await start(page);
  await page.clock.fastForward(120000);
  await page.getByRole('button', { name: 'Pause session', exact: true }).click();
  await expect(page.locator('#timer')).toHaveText('23:00');
  await page.clock.fastForward(180000);
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page.locator('#summary-active')).toHaveText('2 min');
  await expect(page.locator('#summary-paused')).toHaveText('3 min');
  await page.getByLabel('One thing you moved forward').fill('Finished the first examples.');
  await page.reload();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.locator('.history-link').click();
  await expect(page.locator('#reflection')).toHaveValue('Finished the first examples.');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export history' }).click();
  expect((await download).suggestedFilename()).toMatch(/^studybuddy-sessions-.*\.json$/);
  await page.getByRole('button', { name: 'Clear history', exact: true }).click();
  await page.getByRole('button', { name: 'Keep history', exact: true }).click();
  await expect(page.locator('.history-link')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear history', exact: true }).click();
  await page.getByRole('button', { name: 'Delete history', exact: true }).click();
  await expect(page.locator('#history-list')).toContainText('Your first session');
  expect(errors).toEqual([]);
});

test('completion saves exactly one record before a real five-minute break', async ({ page }) => {
  await freezeClock(page); await open(page); await start(page);
  await page.clock.fastForward(25 * 60000);
  await expect(page.locator('#session-label')).toHaveText('Planned break');
  await expect(page.locator('#timer')).toHaveText('05:00');
  await page.clock.fastForward(5 * 60000);
  await expect(page.locator('#summary-view')).toBeVisible();
  await expect(page.locator('#summary-active')).toHaveText('25 min');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.history-link')).toHaveCount(1);
});

test('reload recovers a paused session without restarting the camera', async ({ page }) => {
  await freezeClock(page); await open(page); await start(page);
  await page.clock.fastForward(30000); await page.reload();
  await expect(page.locator('#session-label')).toHaveText('Session paused');
  await expect(page.locator('#sensor-status')).toContainText('Camera off');
  await page.clock.fastForward(60000);
  await expect(page.locator('#timer')).toHaveText('24:30');
  await page.getByRole('button', { name: 'Resume session', exact: true }).click();
  await page.clock.fastForward(30000);
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page.locator('#summary-active')).toHaveText('1 min');
});

test('settings persist and dialog Escape returns keyboard focus', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance').selectOption('dark');
  await page.getByLabel('Keep reminders silent').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Keep reminders silent')).not.toBeChecked();
});

test('back-forward page restoration excludes time spent away from the page', async ({ page }) => {
  await freezeClock(page); await open(page); await start(page);
  await page.clock.fastForward(30000);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page.clock.fastForward(120000);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#session-label')).toHaveText('Session paused');
  await expect(page.locator('#timer')).toHaveText('24:30');
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page.locator('#summary-active')).toHaveText('30 sec');
});

test('camera denial gives a useful message and never blocks the timer', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await open(page);
  await page.getByRole('button', { name: 'Enable camera', exact: true }).click();
  await expect(page.locator('#camera-message')).toContainText('permission was not granted');
  await start(page);
  await expect(page.locator('#session-view')).toBeVisible();
  await expect(page.locator('#sensor-status')).toContainText('Camera unavailable');
});

test('a missing browser camera gives a clear message and leaves the timer usable', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Missing', 'NotFoundError'); };
  });
  await open(page);
  await page.getByRole('button', { name: 'Enable camera', exact: true }).click();
  await expect(page.locator('#camera-message')).toContainText('No camera found');
  await start(page);
  await expect(page.locator('#session-view')).toBeVisible();
});

test('no camera is requested until enabled; blocked storage has an honest fallback', async ({ page }) => {
  await page.addInitScript(() => {
    window.cameraRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.cameraRequests++; throw new Error('No camera'); };
    Storage.prototype.setItem = () => { throw new Error('Blocked'); };
  });
  await open(page); await start(page);
  expect(await page.evaluate(() => window.cameraRequests)).toBe(0);
  await expect(page.locator('#storage-status')).toContainText('Storage unavailable');
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page.locator('#summary-view')).toBeVisible();
});

test('tab-away reminder is optional, delayed, counted once, and snoozable', async ({ page }) => {
  await freezeClock(page);
  await page.addInitScript(() => {
    window.testHidden = false;
    Object.defineProperty(document, 'hidden', { get: () => window.testHidden });
  });
  await open(page);
  await page.getByLabel('Tab-away reminders').check(); await start(page);
  await page.evaluate(() => { window.testHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(20000);
  await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#notice-text')).toContainText('Welcome back');
  await page.getByRole('button', { name: 'Snooze for 5 minutes' }).click();
  await page.evaluate(() => { window.testHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(20000);
  await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#notice')).toBeHidden();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page.locator('#summary-reminders')).toHaveText('1');
  await page.getByText('Session observations', { exact: true }).click();
  await expect(page.locator('#observation-list')).toContainText('40 sec');
});

test('layout works at desktop, tablet, and phone widths in both themes', async ({ page }) => {
  await page.goto('/');
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/web-ready-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/web-ready-mobile.png', fullPage: true });
});

test('StudyBuddy keeps the timer, camera and actions together above the desktop fold', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await expect(page).toHaveTitle(/StudyBuddy/);
  await expect(page.locator('.brand')).toContainText('StudyBuddy');
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.locator('#monitoring-title').click();
  await page.getByLabel('Detection engine').selectOption('browser');
  await page.locator('#monitoring-title').click();
  await start(page, 'Review chapter notes');
  for (const [width, height] of [[1366, 768], [1280, 720], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    const boxes = await page.evaluate(() => {
      const box = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
      return { timer: box('session-view'), camera: box('camera-panel'), pause: box('pause'), end: box('end'), feed: document.querySelector('.camera-frame').getBoundingClientRect().bottom, height: innerHeight, pageHeight: document.documentElement.scrollHeight };
    });
    expect(boxes.timer.right).toBeLessThan(boxes.camera.x);
    expect(Math.abs(boxes.timer.y - boxes.camera.y)).toBeLessThan(1);
    expect(boxes.feed).toBeLessThan(height);
    expect(boxes.pause.bottom).toBeLessThan(height);
    expect(boxes.end.bottom).toBeLessThan(height);
    expect(boxes.pageHeight).toBeLessThanOrEqual(height);
  }
  await page.screenshot({ path: 'test-results/studybuddy-session-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const timer = await page.locator('#session-view').boundingBox(), camera = await page.locator('#camera-panel').boundingBox();
  expect(camera.y).toBeGreaterThan(timer.y + timer.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: 'test-results/studybuddy-session-mobile.png', fullPage: true });
});

test('real MediaPipe models initialize and process a simulated camera; pause releases the device', async ({ browser, baseURL }) => {
  test.setTimeout(120000);
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await context.newPage();
  // This context is separate from the page fixture covered by beforeEach.
  await page.route('**/api/**', r => r.fulfill({ status: 503, json: { detail: 'Python engine isolated in browser-only tests' } }));
  const errors = [], externalRequests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (!r.url().startsWith(baseURL) && !r.url().startsWith('blob:')) externalRequests.push(r.url()); });
  // Inject a synthetic video stream: no physical camera is accessed during tests.
  await page.addInitScript(() => {
    window.cameraStreams = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#778a80'; ctx.fillRect(0, 0, 640, 480);
      const stream = canvas.captureStream(5); window.cameraStreams.push(stream);
      return stream;
    };
  });
  await open(page); await page.getByRole('button', { name: 'Enable camera', exact: true }).click();
  await expect(page.locator('#camera-message')).toContainText('Camera reminders on', { timeout: 60000 });
  await expect(page.locator('#phone-detail')).toHaveText('No phone detected', { timeout: 30000 });
  await expect(page.locator('#face-detail')).toHaveText('Face not in view');
  await expect(page.locator('#hands-detail')).toHaveText('0 in view');
  await start(page);
  await expect(page.locator('#notice-text')).toContainText('cannot see your face', { timeout: 15000 });
  await page.getByRole('button', { name: 'Keep going', exact: true }).click();
  await page.getByRole('button', { name: 'Pause session', exact: true }).click();
  await expect(page.locator('#sensor-status')).toContainText('Camera off');
  expect(await page.evaluate(() => window.cameraStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
  await page.getByRole('button', { name: 'Resume session', exact: true }).click();
  await expect(page.locator('#camera-message')).toContainText('Camera reminders on', { timeout: 60000 });
  await page.getByText('Camera preview & details', { exact: true }).click();
  expect(await page.evaluate(() => window.cameraStreams.at(-1).getTracks()[0].readyState)).toBe('live');
  await page.getByRole('button', { name: 'Turn camera off', exact: true }).click();
  await expect(page.locator('#sensor-status')).toContainText('Camera off');
  expect(await page.evaluate(() => window.cameraStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
  await expect(page.locator('#session-label')).toHaveText('Focus session');
  expect(externalRequests).toEqual([]); expect(errors).toEqual([]);
  await context.close();
});

test('python engine mode lists named cameras, follows the saved camera by name, and shows live distractions', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  // The engine API is mocked: no real camera, window reader, or sound is used.
  const controls = [];
  let cameras = [{ index: 0, name: 'ASUS FHD webcam', virtual: false }, { index: 1, name: 'OBS Virtual Camera', virtual: true }];
  let state = { busy: false, sessionId: null, phase: 'idle', cameraState: 'off', cameraError: null, app: { title: '', name: '', isStudy: false },
    appError: null, sample: null, reason: 'checking', message: '', active: 0, paused: 0, remaining: 1500, breakRemaining: 300, observations: {},
    reminders: 0, event: null, options: { camera: false, appCheck: true, mouthCheck: true, mute: false, mode: 'screen', cameraIndex: 0, allowedApps: [] },
    audioError: null, focusPercent: 0 };
  await page.route('**/api/health', r => r.fulfill({ json: { service: 'studybuddy-python', protocol: 1, key: 'test-key' } }));
  await page.route('**/api/cameras', r => r.fulfill({ json: { cameras, source: 'directshow', selected: 0 } }));
  await page.route('**/api/state', r => r.fulfill({ json: state }));
  await page.route('**/api/stream', r => r.fulfill({ status: 204 }));
  await page.route('**/api/control', async r => {
    const body = r.request().postDataJSON(); controls.push(body);
    if (body.action === 'start') state = { ...state, sessionId: body.sessionId, phase: 'focus', remaining: body.remaining };
    if (body.action === 'end') state = { ...state, phase: 'summary' };
    await r.fulfill({ json: state });
  });
  await page.goto('/');
  await expect(page.locator('#engine-chip')).toContainText('Python engine connected');
  const picker = page.getByLabel('Camera device');
  await expect(picker.locator('option')).toHaveText(['ASUS FHD webcam', 'OBS Virtual Camera · virtual']);
  await picker.selectOption({ label: 'OBS Virtual Camera · virtual' });
  // Plugging in another camera shifts the device numbers; the saved choice follows its name.
  cameras = [{ index: 0, name: 'USB Camera', virtual: false }, { index: 1, name: 'ASUS FHD webcam', virtual: false }, { index: 2, name: 'OBS Virtual Camera', virtual: true }];
  await page.reload();
  await expect(picker).toHaveValue('2');
  await expect(page.locator('#camera-list-hint')).toContainText('3 cameras found');
  await start(page, 'Essay draft');
  await expect.poll(() => controls.find(c => c.action === 'start')).toMatchObject({ camera: true, cameraIndex: 2, cameraName: 'OBS Virtual Camera', appCheck: true });
  await expect(page.locator('#live-card')).toBeVisible();
  state = { ...state, reason: 'distraction-app', message: 'A distracting app or tab is active.', app: { title: 'YouTube - Brave', name: 'Youtube', isStudy: false },
    observations: { 'distraction-app': 4 }, reminders: 1, event: { id: 1, kind: 'distraction-app', message: 'Youtube is distracting you from your task. Return when you are ready.' } };
  await expect(page.locator('#live-status')).toHaveAttribute('data-warning', 'true');
  await expect(page.locator('#active-app')).toContainText('Youtube');
  await expect(page.locator('#notice-text')).toContainText('Youtube is distracting you');
  await page.getByRole('button', { name: 'Keep going', exact: true }).click();
  state = { ...state, cameraState: 'on', cameraFps: 30 };
  await expect(page.locator('#camera-chip')).toHaveText('On');
  const layout = await page.evaluate(() => ({ height: innerHeight, pageHeight: document.documentElement.scrollHeight,
    sections: ['session-view', 'camera-panel', 'live-card'].map(id => ({ id, height: document.getElementById(id).offsetHeight, bottom: document.getElementById(id).getBoundingClientRect().bottom })) }));
  expect(layout.pageHeight, JSON.stringify(layout)).toBeLessThanOrEqual(layout.height);
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page.locator('#summary-view')).toBeVisible();
  await expect(page.locator('#summary-reminders')).toHaveText('1');
});
