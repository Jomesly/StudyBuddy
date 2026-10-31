import { test, expect } from '@playwright/test';

test('the live development server connects to Python through its API proxy', async ({ page, request }) => {
  // Keep health/state real while preventing this connection smoke test from opening hardware.
  await page.route('**/api/cameras', r => r.fulfill({ json: { cameras: [], source: 'directshow', selected: 0 } }));
  const healthResponse = await request.get('/api/health');
  expect(healthResponse.ok()).toBe(true);
  const health = await healthResponse.json();
  expect(health.service).toBe('studybuddy-python');
  const state = await request.get('/api/state', { headers: { 'X-StudyBuddy-Key': health.key, 'X-StudyBuddy-Client': 'connection-smoke-test' } });
  expect(state.ok()).toBe(true);
  await page.goto('/');
  await expect(page.locator('#engine-chip')).toHaveText('Python engine connected');
  // Another real tab may own a preview/session; that is distinct from being offline.
  await expect(page.locator('#engine-connection')).not.toContainText('not connected');
});
