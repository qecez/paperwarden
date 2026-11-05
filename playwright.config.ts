import { defineConfig } from "@playwright/test";
const browserName = process.env.PAPERWARDEN_TEST_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(browserName))
  throw new Error(
    "PAPERWARDEN_TEST_BROWSER must be chromium, firefox, or webkit",
  );
export default defineConfig({
  testDir: "tests/browser",
  timeout: 120000,
  expect: { timeout: 30000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: browserName as "chromium" | "firefox" | "webkit",
    launchOptions: {
      ...(browserName !== "chromium"
        ? {}
        : process.env.CHROMIUM_PATH
          ? { executablePath: process.env.CHROMIUM_PATH }
          : process.platform === "darwin"
            ? {
                executablePath:
                  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              }
            : {}),
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/serve.mjs",
    port: 4175,
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
