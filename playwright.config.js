'use strict';

const { defineConfig } = require('@playwright/test');
const editorTestPort = Number(process.env.EDITOR_TEST_PORT || 43917);

module.exports = defineConfig({
  testDir: './tests/editor/browser',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${editorTestPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    },
    {
      name: 'firefox',
      use: { browserName: 'firefox' }
    },
    {
      name: 'webkit',
      use: { browserName: 'webkit' }
    }
  ],
  webServer: {
    command: 'node tests/editor/browser-server.js',
    url: `http://127.0.0.1:${editorTestPort}`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
