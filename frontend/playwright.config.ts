import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT || 4298)
const baseURL = `http://127.0.0.1:${port}`
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results"
const workers = process.env.PLAYWRIGHT_WORKERS
  ? Number(process.env.PLAYWRIGHT_WORKERS)
  : undefined

export default defineConfig({
  testDir: "./tests",
  testIgnore: "react-service-worker.spec.ts",
  outputDir,
  workers,
  fullyParallel: true,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: `${baseURL}/react/`,
    reuseExistingServer: !process.env.CI,
  },
})
