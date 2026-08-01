import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_SW_PORT || 4363)
const baseURL = `http://127.0.0.1:${port}`
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results"

export default defineConfig({
  testDir: "./tests",
  testMatch: "react-service-worker.spec.ts",
  outputDir,
  fullyParallel: false,
  workers: 1,
  use: { ...devices["Desktop Chrome"], baseURL, serviceWorkers: "allow", trace: "retain-on-failure" },
  webServer: {
    command: `npm run build && SV_SW_CONTRACT_TEST=true npm run preview -- --host 127.0.0.1 --port ${port}`,
    url: `${baseURL}/react/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
