import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_SW_PORT || 4363)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: "./tests",
  testMatch: "react-service-worker.spec.ts",
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
