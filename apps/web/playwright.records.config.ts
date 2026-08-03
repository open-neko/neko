import { defineConfig } from "@playwright/test";

const port = 3321;

export default defineConfig({
  testDir: "./test/visual",
  testMatch: "records-parity.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.002,
    },
  },
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    viewport: { width: 1_440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      `NEXT_PUBLIC_RECORDS_VISUAL_TEST=true OPENNEKO_RECORDS_VISUAL_TEST=true ` +
      `pnpm dev --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/a/crm/opportunity`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
