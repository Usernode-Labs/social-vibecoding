import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const recipeBot = {
  id: "recipebot", slug: "recipebot", name: "RecipeBot", status: "running",
  tagline: "Find a recipe for what you have", active_users: 24,
  is_favorited: true, is_collaborator: true, your_apps_hidden: false,
  favorite_order: 0, open_prs: 0, active_sessions: 0, open_issues: 0,
  self_hosted: false, view_visibility: "public", repo_url: "https://github.com/example/recipebot",
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "ava", canAdminWrite: false } } }))
  await page.route("**/api/budget", (route) => route.fulfill({
    json: { spentCents: 900, limitCents: 2500, byokSpentCents: 120, aiEnabled: true },
  }))
  await page.route((url) => url.pathname === "/api/me/llm-grants", (route) => route.fulfill({ json: { grants: [] } }))
  await page.route((url) => url.pathname === "/api/me/agent-files", (route) => route.fulfill({
    json: { files: [], limits: { maxFilesPerKind: 10, maxFileBytes: 49152 } },
  }))
})

async function platformNavigation(page: import("@playwright/test").Page) {
  const navigation = page.getByRole("navigation", { name: "Platform navigation" })
  if (!await navigation.isVisible()) {
    await page.getByRole("button", { name: "Toggle navigation" }).click()
  }
  await expect(navigation).toBeVisible()
  return navigation
}

async function expectFullCanvasRoute(page: import("@playwright/test").Page, testId: string, title: string) {
  const route = page.getByTestId(testId)
  await expect(route.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await expect(route.locator("h1")).toHaveCount(1)
  await expect.poll(() => route.evaluate((element) => getComputedStyle(element).maxWidth)).toBe("none")
}

test("replaces the dead shell hashes with React settings and feedback routes", async ({ page }) => {
  await page.goto("/react/")

  let navigation = await platformNavigation(page)
  await expect(navigation.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/react/settings")
  await expect(navigation.getByRole("link", { name: "Send feedback" })).toHaveAttribute("href", "/react/feedback")

  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: recipeBot } }))
  await page.goto("/react/apps/recipebot/dev")
  navigation = await platformNavigation(page)
  await expect(navigation.getByRole("link", { name: "Send feedback" })).toHaveAttribute("href", "/react/feedback")
})

test("makes the native-settings boundary explicit in a regular browser", async ({ page }) => {
  await page.goto("/react/settings")

  await expectFullCanvasRoute(page, "settings", "Settings")
  await expect(page.getByTestId("settings-unavailable")).toContainText("Native controls need Usernode")
  await expect(page.getByTestId("settings-unavailable")).toContainText("native permissions, wallet controls")
  await expect(page.getByTestId("settings-web-session")).toContainText("Social Vibecoding session")
})

test("ends the web session after explicit confirmation", async ({ page }) => {
  let logoutRequests = 0
  await page.route("**/api/auth/logout", async (route) => { logoutRequests += 1; await route.fulfill({ json: { ok: true } }) })
  await page.goto("/react/settings")
  await page.getByRole("button", { name: "Log out" }).click()
  await expect(page.getByRole("heading", { name: "Log out of Social Vibecoding?" })).toBeVisible()
  await page.getByRole("button", { name: "Log out" }).last().click()
  await expect.poll(() => logoutRequests).toBe(1)
  await expect(page).toHaveURL(/\/react\/login$/)
})

test("loads and saves the web-owned platform preferences", async ({ page }) => {
  let localeRequest: unknown = null
  let progressRequest: unknown = null
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: {
      user: {
        id: 7,
        username: "ava",
        locale: "en",
        aiProgressEstimate: false,
        hasApiKey: true,
        keyLast4: "7xyz",
      },
    },
  }))
  await page.route("**/api/me/locale", async (route) => {
    localeRequest = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true, locale: "de" } })
  })
  await page.route("**/api/me/ai-progress-estimate", async (route) => {
    progressRequest = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true, enabled: true } })
  })

  await page.goto("/react/settings")
  await expect(page.getByTestId("settings-ai-billing")).toContainText("BYOK active")
  await expect(page.getByTestId("settings-ai-billing")).toContainText("7xyz")

  await page.getByLabel("Language").click()
  await page.getByRole("option", { name: "Deutsch" }).click()
  await expect.poll(() => localeRequest).toEqual({ locale: "de" })
  await expect(page.getByLabel("Language")).toContainText("Deutsch")

  await page.getByRole("switch", { name: "AI progress estimate" }).click()
  await expect.poll(() => progressRequest).toEqual({ enabled: true })
  await expect(page.getByRole("switch", { name: "AI progress estimate" })).toBeChecked()
})

test("shows the canonical platform and personal-key spend when BYOK is active", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: {
      user: {
        id: 7,
        username: "ava",
        hasApiKey: true,
        keyLast4: "7xyz",
      },
    },
  }))

  await page.goto("/react/settings")

  await expect(page.getByTestId("settings-ai-spend")).toContainText("$9.00 of $25.00")
  await expect(page.getByTestId("settings-ai-spend")).toContainText("$1.20")
  await expect(page.getByTestId("settings-ai-spend")).toContainText("Resets midnight UTC")
})

test("persists browser-owned developer preferences without a server mutation", async ({ page }) => {
  await page.goto("/react/settings")

  const consoleToggle = page.getByRole("switch", { name: "Always show developer console" })
  const alertsToggle = page.getByRole("switch", { name: "Dev-chat sound and alerts" })
  await expect(consoleToggle).not.toBeChecked()
  await expect(alertsToggle).toBeChecked()

  await consoleToggle.click()
  await alertsToggle.click()

  await expect.poll(() => page.evaluate(() => ({
    console: localStorage.getItem("usernode:devConsoleMode"),
    alerts: localStorage.getItem("devchat_alerts_enabled"),
  }))).toEqual({ console: "always", alerts: "0" })

  await page.reload()
  await expect(page.getByRole("switch", { name: "Always show developer console" })).toBeChecked()
  await expect(page.getByRole("switch", { name: "Dev-chat sound and alerts" })).not.toBeChecked()
})

test("routes an unread completion from the shared event socket to a background notification", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    class NotificationSocket {
      static instances: NotificationSocket[] = []
      url: string
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: (() => void) | null = null
      constructor(url: string) {
        this.url = url
        NotificationSocket.instances.push(this)
        queueMicrotask(() => this.onopen?.())
      }
      close() {
        this.onclose?.()
      }
      emit(payload: unknown) {
        this.onmessage?.({ data: JSON.stringify(payload) })
      }
    }
    class WebSocketSpy {
      static CONNECTING = NativeWebSocket.CONNECTING
      static OPEN = NativeWebSocket.OPEN
      static CLOSING = NativeWebSocket.CLOSING
      static CLOSED = NativeWebSocket.CLOSED
      constructor(url: string | URL, protocols?: string | string[]) {
        if (String(url).includes("/ws/events")) return new NotificationSocket(String(url))
        return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
      }
    }
    class TestNotification {
      static permission = "granted"
      static requestPermission = async () => "granted"
      onclick: (() => void) | null = null
      constructor(title: string, options?: NotificationOptions) {
        localStorage.setItem("last-dev-alert", JSON.stringify({ title, body: options?.body }))
      }
      close() {}
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: WebSocketSpy })
    Object.defineProperty(window, "Notification", { configurable: true, value: TestNotification })
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    Object.assign(window, { __notificationSockets: NotificationSocket.instances })
  })
  await page.goto("/react/settings")

  await page.evaluate(() => {
    const sockets = (window as typeof window & { __notificationSockets: Array<{ emit: (payload: unknown) => void }> }).__notificationSockets
    sockets[0]?.emit({
      type: "notification_new",
      notification: {
        id: 91,
        kind: "session_done",
        readAt: null,
        appId: 4,
        appSlug: "recipebot",
        appName: "RecipeBot",
        createdAt: "2026-07-28T12:00:00Z",
        sessionId: 23,
        prTitle: "Add pantry filters",
      },
    })
  })

  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("last-dev-alert") || "null"))).toEqual({
    title: "RecipeBot Dev session finished",
    body: "Add pantry filters",
  })
})

test("keeps the previous preference when the server rejects a change", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 7, username: "ava", locale: "en", aiProgressEstimate: false } },
  }))
  await page.route("**/api/me/locale", (route) => route.fulfill({
    status: 500,
    json: { error: "Language could not be saved" },
  }))
  await page.goto("/react/settings")
  await page.getByLabel("Language").click()
  await page.getByRole("option", { name: "Deutsch" }).click()

  await expect(page.getByTestId("settings-preference-error")).toContainText("Language could not be saved")
  await expect(page.getByLabel("Language")).toContainText("English")
})

test("verifies, replaces, and removes a personal Anthropic API key", async ({ page }) => {
  let saveRequest: unknown = null
  let removeRequests = 0
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 7, username: "ava", hasApiKey: false, keyLast4: null } },
  }))
  await page.route("**/api/me/api-key", async (route) => {
    if (route.request().method() === "DELETE") {
      removeRequests += 1
      await route.fulfill({ json: { ok: true } })
      return
    }
    saveRequest = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true, keyLast4: "wxyz" } })
  })

  await page.goto("/react/settings")
  await page.getByLabel("Anthropic API key").fill("sk-ant-example-key-that-is-long-enough-wxyz")
  await page.getByRole("button", { name: "Save key" }).click()
  await expect.poll(() => saveRequest).toEqual({ key: "sk-ant-example-key-that-is-long-enough-wxyz" })
  await expect(page.getByTestId("settings-ai-billing")).toContainText("BYOK active")
  await expect(page.getByTestId("settings-ai-billing")).toContainText("wxyz")
  await expect(page.getByLabel("Anthropic API key")).toHaveValue("")

  await page.getByRole("button", { name: "Remove key" }).click()
  await expect(page.getByRole("heading", { name: "Remove your Anthropic API key?" })).toBeVisible()
  await page.getByRole("button", { name: "Remove key" }).last().click()
  await expect.poll(() => removeRequests).toBe(1)
  await expect(page.getByTestId("settings-ai-billing")).toContainText("Shared budget")
})

test("keeps an entered API key private and editable when verification fails", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 7, username: "ava", hasApiKey: false, keyLast4: null } },
  }))
  await page.route("**/api/me/api-key", (route) => route.fulfill({
    status: 400,
    json: { error: "Anthropic rejected the key." },
  }))
  await page.goto("/react/settings")
  const key = page.getByLabel("Anthropic API key")
  await key.fill("sk-ant-example-key-that-is-long-enough-nope")
  await page.getByRole("button", { name: "Save key" }).click()

  await expect(page.getByText("Anthropic rejected the key.")).toBeVisible()
  await expect(key).toHaveValue("sk-ant-example-key-that-is-long-enough-nope")
  await expect(key).toHaveAttribute("type", "password")
})

test("changes the web password with the current password in a regular browser", async ({ page }) => {
  let passwordRequest: unknown = null
  await page.route("**/api/me/password", async (route) => {
    passwordRequest = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto("/react/settings")
  await page.getByLabel("Current password").fill("temporary-password")
  await page.getByLabel("New password", { exact: true }).fill("new-password-123")
  await page.getByLabel("Confirm new password").fill("new-password-123")
  await page.getByRole("button", { name: "Change password" }).click()

  await expect.poll(() => passwordRequest).toEqual({
    currentPassword: "temporary-password",
    newPassword: "new-password-123",
  })
  await expect(page.getByText("Password changed.")).toBeVisible()
  await expect(page.getByLabel("Current password")).toHaveValue("")
})

test("links a wallet from the web QR request and recognizes it through polling", async ({ page }) => {
  let startRequests = 0
  let statusRequests = 0
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: {
      user: {
        id: 7,
        username: "ava",
        walletLinkEnabled: true,
        usernodePubkey: null,
      },
    },
  }))
  await page.route((url) => url.pathname === "/api/me/wallet-link", async (route) => {
    startRequests += 1
    await route.fulfill({
      json: {
        expiresAt,
        qr: {
          type: "tx",
          to: "platform-wallet",
          amount: 1,
          memo: JSON.stringify({ app: "vibecode", type: "link_wallet", token: "demo-token" }),
          confirmTitle: "Link Wallet",
          confirmSubtitle: "Link your Usernode wallet.",
        },
      },
    })
  })
  await page.route("**/api/me/wallet-link/status", async (route) => {
    statusRequests += 1
    await route.fulfill({
      json: statusRequests > 1
        ? { linked: true, pubkey: "abcdef0123456789abcdef0123456789" }
        : { linked: false, pubkey: null },
    })
  })

  await page.goto("/react/settings")
  await page.getByRole("button", { name: "Link Usernode wallet" }).click()
  await expect.poll(() => startRequests).toBe(1)
  await expect(page.getByText("Scan with the Usernode mobile app")).toBeVisible()
  await expect(page.getByTestId("wallet-link-qr")).toBeVisible()
  await expect(page.getByText(/Expires in \d+:/)).toBeVisible()
  await expect(page.getByTestId("wallet-link-settings")).toContainText("Wallet linked", { timeout: 5000 })
  await expect(page.getByTestId("wallet-link-settings")).toContainText("abcdef0123")
})

test("uses the native transaction confirmation when wallet linking inside Usernode", async ({ page }) => {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  await page.addInitScript(() => {
    Object.defineProperty(window, "usernode", {
      configurable: true,
      value: {
        isNative: true,
        getBridgeInfo: async () => ({
          version: 3,
          capabilities: ["sendTransaction"],
        }),
      },
    })
    Object.defineProperty(window, "sendTransaction", {
      configurable: true,
      value: async (to: string, amount: string | number, memo: string, options: unknown) => {
        localStorage.setItem("wallet-link-transaction", JSON.stringify({ to, amount, memo, options }))
        return { queued: true }
      },
    })
  })
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 7, username: "ava", walletLinkEnabled: true, usernodePubkey: null } },
  }))
  await page.route((url) => url.pathname === "/api/me/wallet-link", (route) => route.fulfill({
    json: {
      expiresAt,
      qr: {
        type: "tx",
        to: "platform-wallet",
        amount: 1,
        memo: "link-token",
        confirmTitle: "Link Wallet",
        confirmSubtitle: "Link your Usernode wallet.",
      },
    },
  }))
  await page.route("**/api/me/wallet-link/status", (route) => route.fulfill({
    json: { linked: false, pubkey: null },
  }))

  await page.goto("/react/settings")
  await page.getByRole("button", { name: "Link Usernode wallet" }).click()
  await expect(page.getByText("Confirm in Usernode")).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("wallet-link-transaction"))).not.toBeNull()
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem("wallet-link-transaction") || "{}"))
  expect(request).toMatchObject({
    to: "platform-wallet",
    amount: 1,
    memo: "link-token",
    options: {
      confirmTitle: "Link Wallet",
      confirmSubtitle: "Link your Usernode wallet.",
      waitForInclusion: false,
    },
  })
})

test("changes the password with a linked native wallet signature", async ({ page }) => {
  let walletPasswordRequest: unknown = null
  await page.addInitScript(() => {
    Object.defineProperty(window, "usernode", {
      configurable: true,
      value: {
        isNative: true,
        getBridgeInfo: async () => ({
          version: 3,
          capabilities: ["getNodeAddress", "signMessage"],
        }),
      },
    })
    Object.defineProperty(window, "signMessage", {
      configurable: true,
      value: async (challenge: string) => ({
        publicKey: "linked-wallet-pubkey",
        signature: `signature-for-${challenge}`,
      }),
    })
  })
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: {
      user: {
        id: 7,
        username: "ava",
        walletLinkEnabled: true,
        usernodePubkey: "linked-wallet-pubkey",
      },
    },
  }))
  await page.route("**/api/auth/wallet-check", (route) => route.fulfill({
    json: { status: "linked", challenge: "single-use-challenge" },
  }))
  await page.route("**/api/me/wallet-change-password", async (route) => {
    walletPasswordRequest = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true } })
  })

  await page.goto("/react/settings")
  await page.getByRole("tab", { name: "Linked wallet" }).click()
  await expect(page.getByLabel("Current password")).toHaveCount(0)
  await page.getByLabel("New password", { exact: true }).fill("wallet-password-123")
  await page.getByLabel("Confirm new password").fill("wallet-password-123")
  await page.getByRole("button", { name: "Sign and change password" }).click()

  await expect.poll(() => walletPasswordRequest).toEqual({
    publicKey: "linked-wallet-pubkey",
    challenge: "single-use-challenge",
    signature: "signature-for-single-use-challenge",
    newPassword: "wallet-password-123",
  })
  await expect(page.getByText("Password changed.")).toBeVisible()
})

test("rejects a mismatched password locally and preserves the form", async ({ page }) => {
  let passwordRequests = 0
  await page.route("**/api/me/password", async (route) => {
    passwordRequests += 1
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto("/react/settings")
  await page.getByLabel("Current password").fill("temporary-password")
  await page.getByLabel("New password", { exact: true }).fill("new-password-123")
  await page.getByLabel("Confirm new password").fill("different-password")
  await page.getByRole("button", { name: "Change password" }).click()

  await expect(page.getByText("New passwords do not match.")).toBeVisible()
  expect(passwordRequests).toBe(0)
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue("new-password-123")
})

test("manages per-app AI caps, personal-key spillover, and revocation", async ({ page }) => {
  const updates: unknown[] = []
  let revocations = 0
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 7, username: "ava", hasApiKey: true, keyLast4: "7xyz" } },
  }))
  await page.route((url) => url.pathname === "/api/me/llm-grants", (route) => route.fulfill({
    json: {
      grants: [{
        appId: 42,
        appName: "RecipeBot",
        appSlug: "recipebot",
        status: "active",
        dailyCapCents: 100,
        allowByok: false,
        spentTodayCents: 37,
        byokSpentTodayCents: 0,
      }],
    },
  }))
  await page.route("**/api/me/llm-grants/42", async (route) => {
    if (route.request().method() === "DELETE") {
      revocations += 1
      await route.fulfill({ json: { ok: true } })
      return
    }
    updates.push(route.request().postDataJSON())
    await route.fulfill({ json: { grant: { appId: 42 } } })
  })

  await page.goto("/react/settings")
  const grant = page.getByTestId("ai-grant-42")
  await expect(grant).toContainText("$0.37 of $1.00 used today")
  await grant.getByLabel("Daily platform budget").fill("2.50")
  await grant.getByRole("button", { name: "Save" }).click()
  await expect.poll(() => updates[0]).toEqual({ dailyCapCents: 250 })

  await grant.getByRole("switch", { name: "Use my key after the platform cap" }).click()
  await expect.poll(() => updates[1]).toEqual({ allowByok: true })
  await expect(grant.getByText("Personal-key spillover enabled.")).toBeVisible()

  await grant.getByRole("button", { name: "Revoke access" }).click()
  await expect(page.getByRole("heading", { name: "Revoke AI access for RecipeBot?" })).toBeVisible()
  await page.getByRole("button", { name: "Revoke access" }).last().click()
  await expect.poll(() => revocations).toBe(1)
  await expect(grant).toContainText("Revoked")
})

test("uploads, inspects, and deletes personal agent files", async ({ page }) => {
  let files = [{
    kind: "instruction",
    name: "code-style",
    description: "",
    size_bytes: 54,
    updated_at: "2026-07-28T10:00:00Z",
  }]
  let saved: unknown = null
  let deleted: unknown = null
  await page.route((url) => url.pathname === "/api/me/agent-files/content", (route) => route.fulfill({
    json: { file: { ...files[0], content: "# Code style\n\nPrefer small functions." } },
  }))
  await page.route((url) => url.pathname === "/api/me/agent-files", async (route) => {
    if (route.request().method() === "POST") {
      saved = route.request().postDataJSON()
      const payload = saved as { kind: string; name: string; description: string; content: string }
      files = [...files, {
        kind: payload.kind,
        name: payload.name,
        description: payload.description,
        size_bytes: payload.content.length,
        updated_at: "2026-07-28T11:00:00Z",
      }]
      await route.fulfill({ status: 201, json: { ok: true, file: files.at(-1) } })
      return
    }
    if (route.request().method() === "DELETE") {
      deleted = route.request().postDataJSON()
      const payload = deleted as { kind: string; name: string }
      files = files.filter((file) => file.kind !== payload.kind || file.name !== payload.name)
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fulfill({ json: { files, limits: { maxFilesPerKind: 10, maxFileBytes: 49152 } } })
  })

  await page.goto("/react/settings")
  const existing = page.getByTestId("agent-file-instruction-code-style")
  await existing.getByRole("button", { name: "View file" }).click()
  await expect(existing.getByText("Prefer small functions.")).toBeVisible()

  await page.locator('input[type="file"]').setInputFiles({
    name: "ui-review.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# UI review\n\nCheck focus and contrast."),
  })
  await expect(page.getByTestId("agent-file-draft")).toBeVisible()
  await page.getByRole("button", { name: "Save file" }).click()
  await expect.poll(() => saved).toEqual({
    kind: "instruction",
    name: "ui-review",
    description: "",
    content: "# UI review\n\nCheck focus and contrast.",
  })
  await expect(page.getByTestId("agent-file-instruction-ui-review")).toBeVisible()

  await existing.getByRole("button", { name: "Delete" }).click()
  await page.getByRole("button", { name: "Delete file" }).click()
  await expect.poll(() => deleted).toEqual({ kind: "instruction", name: "code-style" })
  await expect(existing).toHaveCount(0)
})

test("falls back to the allowlisted native settings screen on an older bridge", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "usernode", {
    configurable: true,
    value: {
      getBridgeInfo: async () => ({ version: 3, capabilities: ["openNativeScreen"] }),
      openNativeScreen: async (screen: string) => { window.localStorage.setItem("opened-native-screen", screen); return true },
    },
  }))
  await page.goto("/react/settings")

  await expect(page.getByTestId("settings-unsupported")).toBeVisible()
  await page.getByRole("button", { name: "Open native settings" }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("opened-native-screen"))).toBe("settings")
})

test("renders and operates the full trusted Usernode app settings surface", async ({ page }) => {
  await page.addInitScript(() => {
    let settings = {
      buildInfo: {
        appVersion: "1.4.2",
        buildNumber: "87",
        nodeVersion: "0.9.1",
        commitHash: "a1b2c3d",
        branch: "develop",
      },
      nodeSleepEnabled: true,
      debugMode: false,
      facematchStrict: true,
      termsAccepted: true,
      authStatus: "authenticated",
      permissions: {
        platform: "android",
        exactAlarmGranted: false,
        batteryOptDisabled: false,
        deviceManufacturer: "samsung",
        iosKeepAliveActive: null,
      },
    }
    const snapshot = () => structuredClone(settings)
    Object.defineProperty(window, "usernode", {
      configurable: true,
      value: {
        getBridgeInfo: async () => ({
          version: 3,
          capabilities: [
            "getSettingsState",
            "setNodeSleepEnabled",
            "setDebugMode",
            "setFacematchStrict",
            "requestPermissions",
            "resetZkChallenge",
            "openBatterySettings",
            "openNativeScreen",
            "logout",
          ],
        }),
        getSettingsState: async () => snapshot(),
        setNodeSleepEnabled: async (enabled: boolean) => {
          settings = { ...settings, nodeSleepEnabled: enabled }
          return snapshot()
        },
        setDebugMode: async (enabled: boolean) => {
          settings = { ...settings, debugMode: enabled }
          return snapshot()
        },
        setFacematchStrict: async (enabled: boolean) => {
          settings = { ...settings, facematchStrict: enabled }
          return snapshot()
        },
        requestPermissions: async () => {
          settings = { ...settings, permissions: { ...settings.permissions, exactAlarmGranted: true } }
          return snapshot()
        },
        resetZkChallenge: async () => {
          localStorage.setItem("native-zk-reset", "true")
          return true
        },
        openBatterySettings: async () => {
          localStorage.setItem("native-battery-opened", "true")
          return true
        },
        openNativeScreen: async (screen: string) => {
          localStorage.setItem("opened-native-screen", screen)
          return true
        },
        logout: async () => {
          localStorage.setItem("native-logout", "true")
          return true
        },
      },
    })
  })
  await page.goto("/react/settings")

  await expect(page.getByTestId("native-app-settings")).toBeVisible()
  await expect(page.getByText("App 1.4.2 (87) · Node 0.9.1 · a1b2c3d")).toBeVisible()
  await expect(page.getByText("Device: samsung")).toBeVisible()

  await page.getByRole("button", { name: "Request permissions" }).click()
  await expect(page.getByTestId("native-app-settings").getByText("Granted", { exact: true })).toBeVisible()

  await page.getByRole("switch", { name: "Node sleep on inactivity" }).click()
  await expect(page.getByRole("switch", { name: "Node sleep on inactivity" })).not.toBeChecked()
  await page.getByRole("switch", { name: "Debug mode" }).click()
  await expect(page.getByRole("switch", { name: "Debug mode" })).toBeChecked()

  await page.getByRole("button", { name: "Open battery settings" }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("native-battery-opened"))).toBe("true")
  await page.getByRole("button", { name: "Device benchmark" }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("opened-native-screen"))).toBe("benchmark")

  await page.getByRole("button", { name: "Restart ZK challenge" }).click()
  await page.getByRole("button", { name: "Restart", exact: true }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("native-zk-reset"))).toBe("true")

  await page.getByRole("button", { name: "Log out of Usernode app", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Log out of the Usernode app?" })).toBeVisible()
  await page.getByRole("button", { name: "Log out of Usernode app", exact: true }).last().click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("native-logout"))).toBe("true")
})

test("reports an unsupported native build without attempting a settings action", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "usernode", {
    configurable: true,
    value: { getBridgeInfo: async () => ({ version: 2, capabilities: [] }) },
  }))
  await page.goto("/react/settings")
  await expect(page.getByTestId("settings-unsupported")).toContainText("does not advertise the settings controls used by this page")
})

test("files app feedback through the canonical endpoint with its validated app context", async ({ page }) => {
  let feedbackRequest: unknown = null
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: recipeBot } }))
  await page.route("**/api/feedback**", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("app")).toBe("recipebot")
    feedbackRequest = route.request().postDataJSON()
    await route.fulfill({ json: { url: "https://github.com/example/recipebot/issues/42", title: "Recipe search misses pantry items" } })
  })
  await page.goto("/react/feedback?app=recipebot")

  await expect(page.getByRole("button", { name: "This app (RecipeBot)" })).toHaveAttribute("aria-pressed", "true")
  await page.getByLabel("Title (optional)").fill("Recipe search misses pantry items")
  await page.getByRole("textbox", { name: "Feedback" }).fill("Recipe search does not match pantry ingredients correctly.")
  await page.getByRole("button", { name: "Submit feedback" }).click()

  await expect.poll(() => feedbackRequest).toEqual({
    appSlug: "recipebot",
    description: "Recipe search does not match pantry ingredients correctly.",
    target: "app",
    title: "Recipe search misses pantry items",
  })
  await expect(page.getByTestId("feedback-success")).toContainText("Recipe search misses pantry items")
  await expect(page.getByRole("link", { name: "View issue" })).toHaveAttribute("href", "https://github.com/example/recipebot/issues/42")
})

test("keeps platform feedback available when no compatible app context exists", async ({ page }) => {
  let feedbackRequest: unknown = null
  await page.route("**/api/feedback**", async (route) => {
    feedbackRequest = route.request().postDataJSON()
    await route.fulfill({ json: { title: "Feedback received" } })
  })
  await page.goto("/react/feedback")

  const feedback = page.getByTestId("feedback")
  await expectFullCanvasRoute(page, "feedback", "Send feedback")
  await expect(feedback.getByRole("link", { name: "Back" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "This app" })).toBeDisabled()
  await page.getByLabel("Title (optional)").fill("Navigation feedback")
  await page.getByRole("textbox", { name: "Feedback" }).fill("The platform navigation needs a clearer active state.")
  await page.getByRole("button", { name: "Submit feedback" }).click()
  await expect.poll(() => feedbackRequest).toEqual({
    description: "The platform navigation needs a clearer active state.",
    target: "platform",
    title: "Navigation feedback",
  })
})

test("keeps feedback form data and explains canonical API errors", async ({ page }) => {
  await page.route("**/api/feedback**", (route) => route.fulfill({ status: 409, json: { error: "This app has no repository yet — try platform feedback" } }))
  await page.goto("/react/feedback")
  await page.getByLabel("Title (optional)").fill("Feedback target")
  await page.getByRole("textbox", { name: "Feedback" }).fill("The current experience should explain where feedback is filed.")
  await page.getByRole("button", { name: "Submit feedback" }).click()

  await expect(page.getByRole("alert")).toContainText("This app has no repository yet — try platform feedback")
  await expect(page.getByRole("textbox", { name: "Feedback" })).toHaveValue("The current experience should explain where feedback is filed.")
})

test("has no critical or serious accessibility violations on settings and feedback", async ({ page }) => {
  await page.goto("/react/settings")
  let results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])

  await page.goto("/react/feedback")
  results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("production review mode prevents feedback and native settings actions", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let feedbackRequests = 0
  await page.addInitScript(() => Object.defineProperty(window, "usernode", {
    configurable: true,
    value: {
      getBridgeInfo: async () => ({ version: 3, capabilities: ["openNativeScreen"] }),
      openNativeScreen: async () => { window.localStorage.setItem("unexpected-native-open", "true"); return true },
    },
  }))
  await page.route("**/api/feedback**", async (route) => { feedbackRequests += 1; await route.fulfill({ status: 500, json: { error: "must not write" } }) })
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: {
      user: {
        id: 7,
        username: "ava",
        walletLinkEnabled: true,
        usernodePubkey: null,
      },
    },
  }))

  await page.goto("/react/settings")
  await expect(page.getByTestId("settings-production-review")).toContainText("Read-only")
  await expect(page.getByTestId("settings-production-review")).toContainText("Account, wallet, and device setting changes are unavailable. Appearance remains available in this browser.")
  await expect(page.getByLabel("Language")).toBeDisabled()
  await expect(page.getByRole("switch", { name: "AI progress estimate" })).toBeDisabled()
  await expect(page.getByLabel("Anthropic API key")).toBeDisabled()
  await expect(page.getByLabel("Current password")).toBeDisabled()
  await expect(page.getByRole("button", { name: "Upload instruction" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Upload skill" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Open native settings" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Link Usernode wallet" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Log out" })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("unexpected-native-open"))).toBeNull()

  await page.goto("/react/feedback")
  await expect(page.getByTestId("feedback-production-review")).toContainText("Read-only")
  await expect(page.getByTestId("feedback-production-review")).toContainText("Feedback submission is unavailable.")
  await expect(page.getByRole("button", { name: "Submit feedback" })).toBeDisabled()
  expect(feedbackRequests).toBe(0)
})
