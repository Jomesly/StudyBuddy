import { defineConfig } from '@playwright/test';

const production = process.env.STUDYBUDDY_TEST_PRODUCTION === '1';
const baseURL = production ? 'http://127.0.0.1:4173' : 'http://127.0.0.1:5174';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  timeout: 90000,
  use: { baseURL, channel: process.env.CI ? undefined : 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: production ? 'npm run preview' : 'npm run dev', url: baseURL, reuseExistingServer: !process.env.CI, timeout: 180000 },
  reporter: [['list']],
});
