import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test("submits the existing cookie-session login contract and returns to Apps", async ({ page }) => {
  let credentials: unknown
  await page.route("**/api/auth/login", async (route) => {
    credentials = route.request().postDataJSON()
    await route.fulfill({ json: { user: { username: "ava" } } })
  })
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }))

  await page.goto("/react/login")
  await page.getByLabel("Username").fill("ava")
  await page.getByLabel("Password").fill("correct horse battery staple")
  await page.getByRole("button", { name: "Log in" }).click()

  await expect(page).toHaveURL(/\/react\/?$/)
  expect(credentials).toEqual({ username: "ava", password: "correct horse battery staple" })
})

test("explains a rejected login without leaving the form", async ({ page }) => {
  await page.route("**/api/auth/login", (route) => route.fulfill({ status: 401, json: { error: "Invalid credentials" } }))

  await page.goto("/react/login")
  await page.getByLabel("Username").fill("ava")
  await page.getByLabel("Password").fill("wrong password")
  await page.getByRole("button", { name: "Log in" }).click()

  await expect(page.getByText("Invalid credentials")).toBeVisible()
  await expect(page).toHaveURL(/\/react\/login$/)
})

async function installNativeWallet(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "usernode", {
      configurable: true,
      value: {
        isNative: true,
        getBridgeInfo: async () => ({
          version: 3,
          capabilities: ["getNodeAddress", "signMessage", "sendTransaction"],
        }),
      },
    })
    Object.defineProperty(window, "getNodeAddress", {
      configurable: true,
      value: async () => "ut1genesiswallet0123456789",
    })
    Object.defineProperty(window, "signMessage", {
      configurable: true,
      value: async (message: string) => ({
        publicKey: "native-public-key",
        signature: `signed:${message}`,
      }),
    })
    Object.defineProperty(window, "sendTransaction", {
      configurable: true,
      value: async (to: string, amount: number | string, memo: string, options: unknown) => {
        localStorage.setItem("login-wallet-transaction", JSON.stringify({ to, amount, memo, options }))
        return { queued: true }
      },
    })
  })
}

test("signs into a linked genesis account through the native wallet", async ({ page }) => {
  await installNativeWallet(page)
  let verification: unknown
  await page.route("**/api/auth/wallet-check", (route) => route.fulfill({
    json: { status: "linked", challenge: "single-use-login-challenge", isGenesis: true },
  }))
  await page.route("**/api/auth/wallet-verify", async (route) => {
    verification = route.request().postDataJSON()
    await route.fulfill({ json: { user: { username: "ava" } } })
  })
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }))

  await page.goto("/react/login#app/appraise-6945af/dev")
  await page.getByRole("button", { name: "Sign in with wallet" }).click()

  await expect(page).toHaveURL(/\/react\/?#app\/appraise-6945af\/dev$/)
  expect(verification).toEqual({
    pubkey: "ut1genesiswallet0123456789",
    publicKey: "native-public-key",
    challenge: "single-use-login-challenge",
    signature: "signed:single-use-login-challenge",
  })
})

test("resets a linked account password with a fresh native signature", async ({ page }) => {
  await installNativeWallet(page)
  let checks = 0
  let reset: unknown
  await page.route("**/api/auth/wallet-check", (route) => {
    checks += 1
    return route.fulfill({
      json: { status: "linked", challenge: `wallet-reset-${checks}`, isGenesis: true },
    })
  })
  await page.route("**/api/auth/wallet-reset-verify", async (route) => {
    reset = route.request().postDataJSON()
    await route.fulfill({ json: { user: { username: "ava" } } })
  })
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }))

  await page.goto("/react/login")
  await page.getByRole("button", { name: "Reset password with wallet" }).click()
  await page.getByLabel("New password", { exact: true }).fill("new-wallet-password")
  await page.getByLabel("Confirm new password").fill("new-wallet-password")
  await page.getByRole("button", { name: "Sign and reset password" }).click()

  await expect(page).toHaveURL(/\/react\/?$/)
  expect(reset).toEqual({
    pubkey: "ut1genesiswallet0123456789",
    publicKey: "native-public-key",
    challenge: "wallet-reset-2",
    signature: "signed:wallet-reset-2",
    newPassword: "new-wallet-password",
  })
})

test("links a new genesis wallet to an existing account through native confirmation", async ({ page }) => {
  await installNativeWallet(page)
  await page.route("**/api/auth/wallet-check", (route) => route.fulfill({
    json: { status: "not_linked", isGenesis: true },
  }))
  await page.route("**/api/auth/wallet-link-login", (route) => route.fulfill({
    json: {
      user: { username: "ava" },
      walletLink: {
        to: "platform-address",
        amount: 1,
        memo: "{\"type\":\"link_wallet\"}",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
  }))
  await page.route("**/api/me/wallet-link/status", (route) => route.fulfill({
    json: { linked: true, pubkey: "ut1genesiswallet0123456789" },
  }))
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }))

  await page.goto("/react/login")
  await page.getByRole("button", { name: "Link existing account" }).click()
  await page.getByLabel("Username").fill("ava")
  await page.getByLabel("Password").fill("correct horse battery staple")
  await page.getByRole("button", { name: "Log in and link wallet" }).click()

  await expect(page).toHaveURL(/\/react\/?$/)
  const transaction = await page.evaluate(() => JSON.parse(localStorage.getItem("login-wallet-transaction") || "{}"))
  expect(transaction).toEqual({
    to: "platform-address",
    amount: 1,
    memo: "{\"type\":\"link_wallet\"}",
    options: {
      confirmTitle: "Link Wallet",
      confirmSubtitle: "Link your Usernode wallet to your Social Vibecoding account.",
      waitForInclusion: false,
    },
  })
})

test("registers a new genesis-wallet account through the established contract", async ({ page }) => {
  await installNativeWallet(page)
  let registration: unknown
  await page.route("**/api/auth/wallet-check", (route) => route.fulfill({
    json: { status: "not_linked", isGenesis: true },
  }))
  await page.route("**/api/auth/wallet-register", async (route) => {
    registration = route.request().postDataJSON()
    await route.fulfill({
      json: {
        user: { username: "new-ava" },
        walletLink: {
          to: "platform-address",
          amount: 1,
          memo: "{\"type\":\"link_wallet\",\"token\":\"new\"}",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    })
  })
  await page.route("**/api/me/wallet-link/status", (route) => route.fulfill({
    json: { linked: true, pubkey: "ut1genesiswallet0123456789" },
  }))
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }))

  await page.goto("/react/login")
  await page.getByRole("button", { name: "Create account" }).click()
  await page.getByLabel("Username").fill("new-ava")
  await page.getByLabel("Password").fill("correct horse battery staple")
  await page.getByRole("button", { name: "Create and link account" }).click()

  await expect(page).toHaveURL(/\/react\/?$/)
  expect(registration).toEqual({
    username: "new-ava",
    password: "correct horse battery staple",
    pubkey: "ut1genesiswallet0123456789",
  })
})

test("keeps wallet recovery but not wallet sign-in for a linked non-genesis account", async ({ page }) => {
  await installNativeWallet(page)
  await page.route("**/api/auth/wallet-check", (route) => route.fulfill({
    json: { status: "linked", challenge: "recovery-only", isGenesis: false },
  }))

  await page.goto("/react/login")
  await expect(page.getByText("Wallet recovery is available")).toBeVisible()
  await expect(page.getByRole("button", { name: "Sign in with wallet" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Reset password with wallet" })).toBeVisible()
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/login")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
