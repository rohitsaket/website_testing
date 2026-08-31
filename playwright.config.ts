import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 4173);
const localURL = `http://127.0.0.1:${PORT}`;

// BASE_URL lets you aim the suite at a real deployment. When it is set, the bundled
// demo site is never booted and the webServer block is dropped entirely.
const externalURL = process.env.BASE_URL;
const baseURL = externalURL ?? localURL;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',

  // Fail the suite on CI if tests were written but accidentally skipped.
  forbidOnly: !!process.env.CI,

  // Retry only on CI, where flaky network/rendering is more likely.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,

  timeout: 30_000,
  expect: { timeout: 5_000 },

  fullyParallel: true,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['html', { open: 'never' }], ['list']],

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    testIdAttribute: 'data-testid',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'Mobile Chrome', use: { ...devices['Pixel 7'] } },
  ],

  webServer: externalURL
    ? undefined
    : {
        command: `node server/server.mjs`,
        url: localURL,
        reuseExistingServer: !process.env.CI,
        stdout: 'ignore',
        stderr: 'pipe',
        env: { PORT: String(PORT) },
      },
});
