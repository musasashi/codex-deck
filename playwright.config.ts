import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/webview',
  workers: 1,
  use: {
    viewport: { width: 960, height: 850 },
    launchOptions: { executablePath: process.env.CODEX_DECK_CHROMIUM },
  },
  reporter: 'list',
});
