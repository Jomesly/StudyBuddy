import { test, expect } from '@playwright/test';
import { Session } from '../../src/session.mjs';

const idle = () => ({ busy: false, sessionId: null, phase: 'idle', cameraState: 'off', app: {}, reason: 'checking',
  message: '', active: 0, paused: 0, remaining: 1500, breakRemaining: 300, observations: {}, reminders: 0,
  options: { camera: false, appCheck: true, mouthCheck: true, mode: 'screen' } });

async function engine(page, initial = idle()) {
  let state = initial;
  const controls = [];
  await page.route('**/api/health', r => r.fulfill({ json: { service: 'studybuddy-python', protocol: 1, key: 'test-key' } }));
  await page.route('**/api/cameras', r => r.fulfill({ json: { cameras: [], selected: 0 } }));
  await page.route('**/api/state', r => r.fulfill({ json: state }));
  await page.route('**/api/stream', r => r.fulfill({ status: 204 }));
  await page.route('**/api/control', async r => {
    const body = r.request().postDataJSON(); controls.push(body);
    if (body.action === 'start') state = { ...state, ...body, phase: 'focus', options: { ...state.options, camera: body.camera } };
    if (body.action === 'resume') state = { ...state, phase: 'focus' };
    if (body.action === 'pause') state = { ...state, phase: 'paused' };
    if (body.action === 'end') state = { ...state, phase: 'summary' };
    if (body.action === 'recover') state = { ...state, busy: false, released: false, options: { ...state.options, camera: false } };
    await r.fulfill({ json: state });
  });
  return { controls, set(next) { state = next; }, get() { return state; } };
}

test('an engine restart preserves progress and allows Resume or End', async ({ page }) => {
  const api = await engine(page);
  await page.goto('/');
  await expect(page.locator('#engine-chip')).toContainText('connected');
  await page.locator('#task').fill('Review biology');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  api.set({ ...api.get(), active: 40, remaining: 1460, observations: { present: 35 },
    event: { id: 1, kind: 'distraction-app', message: 'First engine reminder.' } });
  await expect(page.locator('#timer')).toHaveText('24:20');
  await expect(page.locator('#notice-text')).toHaveText('First engine reminder.');
  api.set(idle());
  await expect(page.locator('#session-label')).toHaveText('Session paused');
  await expect(page.locator('#notice-text')).toContainText('engine restart');
  await expect(page.locator('#camera')).not.toBeChecked();
  await page.getByRole('button', { name: 'Resume session', exact: true }).click();
  await expect(page.locator('#session-label')).toHaveText('Focus session');
  expect(api.controls.filter(c => c.action === 'start').at(-1)).toMatchObject({ task: 'Review biology', active: 40, remaining: 1460, camera: false });
  api.set({ ...api.get(), event: { id: 1, kind: 'distraction-app', message: 'Reminder after engine restart.' } });
  await expect(page.locator('#notice-text')).toHaveText('Reminder after engine restart.');
  api.set(idle());
  await expect(page.locator('#session-label')).toHaveText('Session paused');
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page.locator('#summary-active')).toHaveText('40 sec');
  expect(api.controls.some(c => c.action === 'end')).toBe(false);
});

test('an abandoned session can be explicitly recovered without opening the camera', async ({ page }) => {
  const state = { ...idle(), sessionId: 'abandoned-session', task: 'Recovered chapter', duration: 1500,
    startedAt: new Date().toISOString(), active: 45, remaining: 1455, phase: 'paused', busy: true, canRecover: false };
  const api = await engine(page, state);
  await page.goto('/');
  await expect(page.locator('#notice-text')).toContainText('Another StudyBuddy tab');
  await expect(page.getByRole('button', { name: 'Recover session', exact: true })).toHaveCount(0);
  api.set({ ...state, canRecover: true });
  await page.getByRole('button', { name: 'Recover session', exact: true }).click();
  await expect(page.locator('#session-label')).toHaveText('Session paused');
  await expect(page.locator('#timer')).toHaveText('24:15');
  await expect(page.locator('#camera')).not.toBeChecked();
  expect(api.controls.some(c => c.action === 'preview')).toBe(false);
  await page.getByRole('button', { name: 'Resume session', exact: true }).click();
  await expect(page.locator('#session-label')).toHaveText('Focus session');
});

test('distractions are announced, snooze is visible, and FPS changes do not repeat camera announcements', async ({ page }) => {
  const api = await engine(page);
  await page.goto('/');
  await page.locator('#task').fill('Draft essay');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  api.set({ ...api.get(), cameraState: 'on', cameraFps: 30, reason: 'distraction-app',
    event: { id: 1, kind: 'distraction-app', message: 'Return to your essay.' } });
  await expect(page.locator('#notice-announcer')).toHaveText('Return to your essay.');
  await expect(page.locator('#notice-announcer')).toHaveAttribute('role', 'status');
  await expect(page.locator('#camera-fps')).toContainText('30 FPS');
  await page.evaluate(() => {
    window.cameraAnnouncements = 0;
    new MutationObserver(() => window.cameraAnnouncements++).observe(document.getElementById('camera-message'), { childList: true, characterData: true, subtree: true });
  });
  api.set({ ...api.get(), cameraFps: 28, snoozeRemaining: 295 });
  await expect(page.locator('#camera-fps')).toContainText('28 FPS');
  await expect(page.locator('#snooze-status')).toHaveText('Reminders snoozed · 04:55');
  expect(await page.evaluate(() => window.cameraAnnouncements)).toBe(0);
  await expect(page.locator('#camera-fps')).toHaveAttribute('aria-live', 'off');
});

test('history imports into an empty library, keeps duplicate notes, and rejects invalid or unsaved merges', async ({ page }) => {
  await page.route('**/api/**', r => r.fulfill({ status: 503, json: {} }));
  await page.goto('/');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const record = new Session({ task: 'Saved algebra' }); record.end();
  const backup = { ...record.record(), note: 'My original reflection' };
  const upload = sessions => page.locator('#history-file').setInputFiles({ name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ sessions })) });
  await upload([backup]);
  await expect(page.locator('#import-status')).toContainText('Imported 1 session');
  await expect(page.locator('.history-link')).toHaveCount(1);
  await upload([{ ...backup, note: 'Do not replace my note' }]);
  await expect(page.locator('#import-status')).toContainText('Existing notes were kept');
  await upload([{ ...backup, active: -1 }]);
  await expect(page.locator('#import-status')).toContainText('invalid session');
  await expect(page.locator('.history-link')).toHaveCount(1);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw Error('quota'); }; });
  await upload([{ ...backup, id: 'new-record', task: 'Unsaved import' }]);
  await expect(page.locator('#import-status')).toContainText('could not be saved');
  await expect(page.locator('.history-link')).toHaveCount(1);
  await page.locator('.history-link').click();
  await expect(page.locator('#reflection')).toHaveValue('My original reflection');
});

test('mobile setup leads with the form; statistics appear only in History; reminder interval persists', async ({ page }) => {
  await page.route('**/api/**', r => r.fulfill({ status: 503, json: {} }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#stats')).toBeHidden();
  expect(await page.locator('#task').boundingBox().then(b => b.y)).toBeLessThan(400);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('#stats')).toBeVisible();
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.locator('#camera-details')).toBeHidden();
  await expect(page.locator('#workspace-status')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Minimum time between reminders').selectOption('120');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Minimum time between reminders')).toHaveValue('120');
});
