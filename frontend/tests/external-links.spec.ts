import { readFileSync } from "node:fs"

import { expect, test, type Page } from "@playwright/test"

const hostedBridge = readFileSync(
  new URL("../../public/usernode-bridge.js", import.meta.url),
  "utf8"
)

async function routeShellReads(page: Page) {
  await page.route("**/api/notifications?**", (route) => route.fulfill({
    json: { notifications: [], unread: 0, hasMore: false, nextBefore: null },
  }))
  await page.route("**/api/node-status/full", (route) => route.fulfill({
    json: { node: { status: "synced" } },
  }))
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 403,
    json: { error: "Admin access required" },
  }))
}

async function installHostedNativeBridge(page: Page) {
  await page.addInitScript({ content: `
    Object.defineProperty(window, "Usernode", {
      configurable: true,
      value: {
        postMessage(message) {
          const envelope = JSON.parse(message);
          const envelopes = JSON.parse(
            sessionStorage.getItem("raw-native-envelopes") || "[]"
          );
          envelopes.push(envelope);
          sessionStorage.setItem(
            "raw-native-envelopes",
            JSON.stringify(envelopes)
          );

          let value = null;
          let error = null;
          if (envelope.method === "getBridgeInfo") {
            value = { version: 3, capabilities: ["openExternal"] };
          } else if (envelope.method === "openExternal") {
            value = true;
            sessionStorage.setItem(
              "raw-channel-opened",
              envelope.args && envelope.args.url
            );
          } else {
            error = "Unexpected native method: " + envelope.method;
          }
          window.setTimeout(
            () => window.__usernodeResolve?.(envelope.id, value, error),
            0
          );
        },
      },
    });
    ${hostedBridge}
  ` })
}

async function appendLink(page: Page, options: {
  download?: string
  href?: string
  label: string
  target?: string
}) {
  await page.evaluate((linkOptions) => {
    const anchor = document.createElement("a")
    anchor.href = linkOptions.href || `https://example.test/${linkOptions.label}`
    anchor.textContent = linkOptions.label
    if (linkOptions.target) anchor.target = linkOptions.target
    if (linkOptions.download) anchor.download = linkOptions.download
    document.body.append(anchor)
  }, options)
}

async function activateLink(
  page: Page,
  label: string,
  init: Pick<MouseEventInit, "altKey" | "ctrlKey" | "metaKey" | "shiftKey"> = {}
) {
  return page.getByRole("link", { name: label }).evaluate((node, eventInit) => {
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
      ...eventInit,
    })
    node.dispatchEvent(event)
    return event.defaultPrevented
  }, init)
}

async function activateMiddleLink(page: Page, label: string) {
  return page.getByRole("link", { name: label }).evaluate((node) => {
    const event = new MouseEvent("auxclick", {
      bubbles: true,
      button: 1,
      cancelable: true,
    })
    node.dispatchEvent(event)
    return event.defaultPrevented
  })
}

test("captures an early native click while capability discovery is pending", async ({ page }) => {
  await routeShellReads(page)
  await page.route("**/usernode-bridge.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.usernode = {
        isNative: true,
        getBridgeInfo: () => new Promise((resolve) => {
          window.__resolveExternalBridge = resolve
        }),
        openExternal: async (url) => {
          const opened = JSON.parse(sessionStorage.getItem("native-externals") || "[]")
          opened.push(url)
          sessionStorage.setItem("native-externals", JSON.stringify(opened))
          return true
        },
      }
    `,
  }))

  await page.goto("/react/missing")
  await expect(page.locator("html")).toHaveAttribute("data-external-link-mode", "probing")
  await appendLink(page, { label: "Early modified external" })
  await appendLink(page, { label: "Early middle external" })
  expect(await activateLink(page, "Early modified external", { ctrlKey: true })).toBe(true)
  expect(await activateMiddleLink(page, "Early middle external")).toBe(true)

  await expect(page).toHaveURL(/\/react\/missing$/)
  expect(await page.evaluate(() => sessionStorage.getItem("native-externals"))).toBeNull()

  await page.evaluate(() => {
    ;(window as Window & {
      __resolveExternalBridge?: (info: { version: number; capabilities: string[] }) => void
    }).__resolveExternalBridge?.({ version: 3, capabilities: ["openExternal"] })
  })
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("native-externals")))
    .toBe(JSON.stringify([
      "https://example.test/Early%20modified%20external",
      "https://example.test/Early%20middle%20external",
    ]))
  await expect(page.locator("html")).toHaveAttribute("data-external-link-mode", "native")
})

test("leaves authored targets, downloads, and modified clicks untouched in browser mode", async ({ page }) => {
  await routeShellReads(page)
  await page.route("**/usernode-bridge.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.usernode = {
        isNative: false,
        getBridgeInfo: async () => ({ version: 0, capabilities: [] }),
      }
    `,
  }))
  await page.goto("/react/missing")
  await expect(page.locator("html")).toHaveAttribute("data-external-link-mode", "browser")

  await page.evaluate(() => {
    const testWindow = window as Window & {
      __clickResults: Array<{
        defaultPrevented: boolean
        download: string | null
        target: string | null
        text: string | null
      }>
    }
    testWindow.__clickResults = []
    document.addEventListener("click", (event) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null
      if (!anchor) return
      testWindow.__clickResults.push({
        defaultPrevented: event.defaultPrevented,
        download: anchor.getAttribute("download"),
        target: anchor.getAttribute("target"),
        text: anchor.textContent,
      })
      event.preventDefault()
    })
  })

  await appendLink(page, { label: "Same tab", target: "_self" })
  await appendLink(page, { label: "New tab", target: "_blank" })
  await appendLink(page, { label: "Named target", target: "docs-pane" })
  await appendLink(page, { download: "report.csv", label: "Download" })

  for (const name of ["Same tab", "New tab", "Named target", "Download"]) {
    await activateLink(page, name)
  }
  await activateLink(page, "Same tab", { ctrlKey: true })

  const results = await page.evaluate(() => (
    window as Window & {
      __clickResults?: Array<{
        defaultPrevented: boolean
        download: string | null
        target: string | null
        text: string | null
      }>
    }
  ).__clickResults)
  expect(results).toEqual([
    { defaultPrevented: false, download: null, target: "_self", text: "Same tab" },
    { defaultPrevented: false, download: null, target: "_blank", text: "New tab" },
    { defaultPrevented: false, download: null, target: "docs-pane", text: "Named target" },
    { defaultPrevented: false, download: "report.csv", target: null, text: "Download" },
    { defaultPrevented: false, download: null, target: "_self", text: "Same tab" },
  ])
})

test("delegates eligible native links and blocks unsupported forms inside the trusted frame", async ({ page }) => {
  await routeShellReads(page)
  await page.route("**/usernode-bridge.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.usernode = {
        isNative: true,
        getBridgeInfo: async () => ({ version: 3, capabilities: ["openExternal"] }),
        openExternal: async (url) => {
          const opened = JSON.parse(sessionStorage.getItem("native-opened") || "[]")
          opened.push(url)
          sessionStorage.setItem("native-opened", JSON.stringify(opened))
          return true
        },
      }
    `,
  }))
  await page.goto("/react/missing")
  await expect(page.locator("html")).toHaveAttribute("data-external-link-mode", "native")
  await page.evaluate(() => {
    const testWindow = window as Window & {
      __clickResults: Array<{ defaultPrevented: boolean; text: string | null }>
    }
    testWindow.__clickResults = []
    document.addEventListener("click", (event) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null
      if (!anchor) return
      testWindow.__clickResults.push({ defaultPrevented: event.defaultPrevented, text: anchor.textContent })
      event.preventDefault()
    })
  })

  await appendLink(page, { label: "Native self", target: "_self" })
  await appendLink(page, { label: "Native blank", target: "_blank" })
  await appendLink(page, { label: "Named native", target: "docs-pane" })
  await appendLink(page, { download: "report.csv", label: "Native download" })
  await appendLink(page, { href: "https://user:pass@example.test/private", label: "Credential link" })
  await appendLink(page, { href: "mailto:security@example.test", label: "Mail link" })

  expect(await activateLink(page, "Native self")).toBe(true)
  expect(await activateLink(page, "Native blank")).toBe(true)
  expect(await activateLink(page, "Native self", { metaKey: true })).toBe(true)
  expect(await activateLink(page, "Named native")).toBe(true)
  expect(await activateLink(page, "Native download")).toBe(true)
  expect(await activateLink(page, "Credential link")).toBe(true)
  expect(await activateLink(page, "Mail link")).toBe(true)

  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("native-opened"))).toBe(
    JSON.stringify([
      "https://example.test/Native%20self",
      "https://example.test/Native%20blank",
      "https://example.test/Native%20self",
    ])
  )
  expect(await page.evaluate(() => (
    window as Window & { __clickResults?: unknown[] }
  ).__clickResults)).toEqual([])
  await expect(page).toHaveURL(/\/react\/missing$/)
  await expect(page.locator("html")).toHaveAttribute("data-external-link-failure", "native-link-unsupported")
  await expect(page.getByRole("alert")).toContainText("Link isn’t supported here")
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0)
  await page.getByRole("button", { name: "Dismiss" }).click()
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("suppresses unmasked modified and middle-click navigation in native mode", async ({ page }) => {
  await routeShellReads(page)
  await page.route("**/usernode-bridge.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.usernode = {
        isNative: true,
        getBridgeInfo: async () => ({ version: 3, capabilities: ["openExternal"] }),
        openExternal: async (url) => {
          const opened = JSON.parse(sessionStorage.getItem("native-unmasked") || "[]")
          opened.push(url)
          sessionStorage.setItem("native-unmasked", JSON.stringify(opened))
          return true
        },
      }
    `,
  }))
  await page.goto("/react/missing")
  await expect(page.locator("html")).toHaveAttribute("data-external-link-mode", "native")
  await appendLink(page, { label: "Modified without mask" })
  await appendLink(page, { label: "Middle without mask" })

  // Deliberately no downstream click listener calls preventDefault: this
  // proves the capture handler itself owns suppression inside the WebView.
  expect(await activateLink(page, "Modified without mask", { metaKey: true })).toBe(true)
  expect(await activateMiddleLink(page, "Middle without mask")).toBe(true)

  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("native-unmasked")))
    .toBe(JSON.stringify([
      "https://example.test/Modified%20without%20mask",
      "https://example.test/Middle%20without%20mask",
    ]))
  await expect(page).toHaveURL(/\/react\/missing$/)
})

test("keeps special same-origin activations in the trusted native top frame", async ({ page }) => {
  await routeShellReads(page)
  await page.route("**/usernode-bridge.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.usernode = {
        isNative: true,
        getBridgeInfo: async () => ({ version: 3, capabilities: ["openExternal"] }),
      }
    `,
  }))

  const cases = [
    { label: "Internal blank", target: "_blank" },
    { label: "Internal modified", metaKey: true },
    { label: "Internal middle", middle: true },
  ] as const

  for (const testCase of cases) {
    await page.goto("/react/missing")
    await expect(page.locator("html")).toHaveAttribute("data-external-link-mode", "native")
    await appendLink(page, {
      href: "/react/settings",
      label: testCase.label,
      ...("target" in testCase ? { target: testCase.target } : {}),
    })

    if ("middle" in testCase) {
      await activateMiddleLink(page, testCase.label)
    } else {
      await activateLink(
        page,
        testCase.label,
        "metaKey" in testCase ? { metaKey: testCase.metaKey } : {}
      )
    }
    await expect(page).toHaveURL(/\/react\/settings$/)
  }
})

test("uses the real hosted wrapper with the raw Flutter channel", async ({ page }) => {
  await routeShellReads(page)
  await installHostedNativeBridge(page)

  await page.goto("/react/missing")
  await expect(page.locator("html")).toHaveAttribute("data-external-link-mode", "native")
  await appendLink(page, { label: "Raw channel external" })
  expect(await activateLink(page, "Raw channel external")).toBe(true)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("raw-channel-opened")))
    .toBe("https://example.test/Raw%20channel%20external")
  await expect(page).toHaveURL(/\/react\/missing$/)

  const openEnvelope = await page.evaluate(() => {
    const envelopes = JSON.parse(
      sessionStorage.getItem("raw-native-envelopes") || "[]"
    ) as Array<{ args?: { url?: string }; method?: string }>
    return envelopes.find((envelope) => envelope.method === "openExternal")
  })
  expect(openEnvelope).toMatchObject({
    args: { url: "https://example.test/Raw%20channel%20external" },
    method: "openExternal",
  })

  const invalidResults = await page.evaluate(async () => {
    const wrapper = (window as Window & {
      usernode?: { openExternal?: (url: string) => Promise<boolean> }
    }).usernode?.openExternal
    if (!wrapper) return []
    return Promise.all([
      wrapper("").then(() => "resolved", () => "rejected"),
      wrapper("mailto:security@example.test").then(() => "resolved", () => "rejected"),
      wrapper("https://user:pass@example.test/private").then(() => "resolved", () => "rejected"),
    ])
  })
  expect(invalidResults).toEqual(["rejected", "rejected", "rejected"])
  expect(await page.evaluate(() => {
    const envelopes = JSON.parse(
      sessionStorage.getItem("raw-native-envelopes") || "[]"
    ) as Array<{ method?: string }>
    return envelopes.filter((envelope) => envelope.method === "openExternal").length
  })).toBe(1)
})

test("reports a recoverable failure without an async popup or WebView navigation", async ({ page }) => {
  await routeShellReads(page)
  await page.addInitScript(() => {
    Object.defineProperty(window, "open", {
      configurable: true,
      value() {
        sessionStorage.setItem("popup-called", "true")
        return null
      },
    })
  })
  await page.route("**/usernode-bridge.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      let behavior = "false"
      window.usernode = {
        isNative: true,
        getBridgeInfo: async () => ({ version: 3, capabilities: ["openExternal"] }),
        openExternal: async () => {
          if (behavior === "reject") throw new Error("native launch failed")
          if (behavior === "string") return "true"
          if (behavior === "true") return true
          return false
        },
      }
      window.__setExternalBehavior = (next) => { behavior = next }
    `,
  }))
  await page.goto("/react/missing")
  await page.evaluate(() => {
    const testWindow = window as Window & {
      __externalFailures: Array<{ hasRetry: boolean; reason: string; url: string }>
      __retryExternal?: () => Promise<boolean>
    }
    testWindow.__externalFailures = []
    document.addEventListener("usernode:external-link-failure", (event) => {
      const detail = (event as CustomEvent).detail
      testWindow.__externalFailures.push({
        hasRetry: typeof detail.retry === "function",
        reason: detail.reason,
        url: detail.url,
      })
      testWindow.__retryExternal = detail.retry
    })
  })
  await appendLink(page, { label: "Recoverable external" })

  for (const behavior of ["false", "reject", "string"]) {
    await page.evaluate((next) => (
      window as Window & { __setExternalBehavior?: (value: string) => void }
    ).__setExternalBehavior?.(next), behavior)
    expect(await activateLink(page, "Recoverable external")).toBe(true)
  }

  await expect.poll(() => page.evaluate(() => (
    window as Window & { __externalFailures?: unknown[] }
  ).__externalFailures?.length)).toBe(3)
  expect(await page.evaluate(() => sessionStorage.getItem("popup-called"))).toBeNull()
  await expect(page).toHaveURL(/\/react\/missing$/)
  await expect(page.locator("html")).toHaveAttribute("data-external-link-failure", "native-open-failed")
  await expect(page.getByRole("alert")).toContainText("Link didn’t open")
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()

  await page.evaluate(() => (
    window as Window & { __setExternalBehavior?: (value: string) => void }
  ).__setExternalBehavior?.("true"))
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.locator("html")).not.toHaveAttribute("data-external-link-failure")
  await expect(page.getByRole("alert")).toHaveCount(0)

  expect(await page.evaluate(() => (
    window as Window & {
      __externalFailures?: Array<{ hasRetry: boolean; reason: string; url: string }>
    }
  ).__externalFailures)).toEqual([
    {
      hasRetry: true,
      reason: "native-open-failed",
      url: "https://example.test/Recoverable%20external",
    },
    {
      hasRetry: true,
      reason: "native-open-failed",
      url: "https://example.test/Recoverable%20external",
    },
    {
      hasRetry: true,
      reason: "native-open-failed",
      url: "https://example.test/Recoverable%20external",
    },
  ])
})
