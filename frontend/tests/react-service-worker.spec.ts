import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

const builtWorkerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/react/react-sw.js",
)

function workerRevision(source: string) {
  const match = source.match(/const BUILD_REVISION = "([^"]+)"/)
  if (!match) throw new Error("Built React worker has no generated revision")
  return match[1]
}

async function installApiFixtures(page: import("@playwright/test").Page) {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 7, username: "ava", canAdminWrite: false } },
  }))
  await page.route("**/api/apps**", (route) => route.fulfill({
    json: { apps: [], categories: [], featured: [], yourApps: [] },
  }))
  await page.route("**/api/node-status/full", (route) => route.fulfill({
    json: { node: null },
  }))
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }))
}

async function workerStatus(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const controller = navigator.serviceWorker.controller
    if (!controller) throw new Error("Missing service worker controller")
    return new Promise<{
      bootAssetCount: number
      bootAssets: string[]
      bootAssetsReady: boolean
      buildRevision: string
      cacheName: string
      cacheReady: boolean
      lastSessionClearAt: number | null
      missingBootAssets: string[]
      ok: true
      retainedCaches: string[]
      scope: string
      version: string
    }>((resolve, reject) => {
      const channel = new MessageChannel()
      const timer = window.setTimeout(() => reject(new Error("Worker status timed out")), 5000)
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timer)
        resolve(event.data)
      }
      controller.postMessage({ type: "get-react-shell-status" }, [channel.port2])
    })
  })
}

async function setFixtureDeployment(
  request: import("@playwright/test").APIRequestContext,
  mode: "current" | "old",
) {
  const response = await request.post(`/react/__sw-test/deployment?mode=${mode}`)
  expect(response.ok()).toBe(true)
}

async function registerFixtureWorker(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/react/react-sw.js", {
      scope: "/react/",
      updateViaCache: "none",
    })
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })
      })
    }
    return registration.scope
  })
}

test.beforeEach(async ({ page }) => {
  await installApiFixtures(page)
})

test("keeps one old deployment available to an already-open tab after the new worker claims it", async ({
  context,
  page,
  request,
}) => {
  const currentRevision = workerRevision(fs.readFileSync(builtWorkerPath, "utf8"))
  await setFixtureDeployment(request, "old")
  await page.goto("/react/__sw-test/client")
  await registerFixtureWorker(page)
  const oldStatus = await workerStatus(page)
  expect(oldStatus).toMatchObject({
    buildRevision: `old-${currentRevision}`,
    bootAssetsReady: true,
    missingBootAssets: [],
  })
  expect(oldStatus.bootAssets).toContain("/react/__sw-test/old-lazy.js")

  await setFixtureDeployment(request, "current")
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/react/")
    if (!registration) throw new Error("Missing fixture registration")
    await new Promise<void>((resolve, reject) => {
      const deadline = window.setTimeout(() => reject(new Error("New worker did not claim the old client")), 5000)
      const oldController = navigator.serviceWorker.controller
      const claimed = () => {
        if (navigator.serviceWorker.controller === oldController) return
        window.clearTimeout(deadline)
        navigator.serviceWorker.removeEventListener("controllerchange", claimed)
        resolve()
      }
      navigator.serviceWorker.addEventListener("controllerchange", claimed)
      void registration.update().catch((cause) => {
        window.clearTimeout(deadline)
        navigator.serviceWorker.removeEventListener("controllerchange", claimed)
        reject(cause)
      })
    })
  })

  const currentStatus = await workerStatus(page)
  expect(currentStatus).toMatchObject({
    buildRevision: currentRevision,
    bootAssetsReady: true,
    missingBootAssets: [],
  })
  expect(currentStatus.retainedCaches).toEqual([oldStatus.cacheName])

  await context.setOffline(true)
  const oldLazySource = await page.evaluate(async () =>
    (await fetch("/react/__sw-test/old-lazy.js")).text())
  expect(oldLazySource).toContain("__oldLazyChunk = 'available'")
})

test("publishes verified readiness for the React-scoped worker", async ({ page }) => {
  await page.goto("/react/")
  await expect.poll(() => page.locator("html").getAttribute("data-react-shell-ready")).toBe("true")

  const evidence = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return {
      controller: navigator.serviceWorker.controller?.scriptURL,
      scope: registration.scope,
    }
  })
  expect(evidence.controller).toMatch(/\/react\/react-sw\.js$/)
  expect(evidence.scope).toMatch(/\/react\/$/)

  const status = await workerStatus(page)
  expect(status).toMatchObject({
    ok: true,
    version: "v1",
    buildRevision: await page.locator("html").getAttribute("data-react-shell-revision"),
    cacheReady: true,
    bootAssetsReady: true,
    missingBootAssets: [],
  })
  expect(status.cacheName).toContain(status.buildRevision)
  expect(status.bootAssetCount).toBe(status.bootAssets.length)
  expect(status.bootAssets).toEqual(expect.arrayContaining([
    "/react/",
    "/react/app-shortcut-contract.js",
    "/usernode-bridge.js",
    "/js/dev-host.js",
    "/js/offline.js",
  ]))
  expect(status.bootAssets.some((asset) => asset.endsWith(".css"))).toBe(true)
  expect(status.bootAssets.some((asset) => asset.includes("/assets/") && asset.endsWith(".js"))).toBe(true)
})

test("reloads offline immediately after first readiness without a warming navigation", async ({ page, context }) => {
  await page.goto("/react/")
  await expect.poll(() => page.locator("html").getAttribute("data-react-shell-ready")).toBe("true")
  await page.evaluate(() => fetch("/api/auth/me", { credentials: "same-origin" }))

  const cachedPaths = await page.evaluate(async () => {
    const names = await caches.keys()
    const requests = (await Promise.all(names
      .filter((name) => name.startsWith("usernode-react-shell-"))
      .map(async (name) => (await caches.open(name)).keys()))).flat()
    return requests.map((request) => new URL(request.url).pathname)
  })
  expect(cachedPaths.some((path) => path.startsWith("/api/"))).toBe(false)

  await page.unrouteAll({ behavior: "wait" })
  await context.setOffline(true)
  await expect.poll(() => page.evaluate(async () => {
    try {
      await fetch("/api/auth/me", { credentials: "same-origin" })
      return "resolved"
    } catch {
      return "failed"
    }
  })).toBe("failed")
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-react-shell-ready", "true")
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible()
})

test("acknowledges session clearing without discarding the offline shell", async ({ page }) => {
  await page.goto("/react/")
  await expect.poll(() => page.locator("html").getAttribute("data-react-shell-ready")).toBe("true")

  const reply = await page.evaluate(async () => {
    const controller = navigator.serviceWorker.controller
    if (!controller) throw new Error("Missing service worker controller")
    return new Promise<{
      buildRevision: string
      ok: true
      clearedAt: number
      type: "clear-react-session-cache"
      version: string
    }>((resolve) => {
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => resolve(event.data)
      controller.postMessage({ type: "clear-react-session-cache" }, [channel.port2])
    })
  })
  expect(reply.ok).toBe(true)
  expect(reply.type).toBe("clear-react-session-cache")
  expect(reply.version).toBe("v1")
  expect(reply.clearedAt).toBeGreaterThan(0)

  const status = await workerStatus(page)
  expect(status.buildRevision).toBe(reply.buildRevision)
  expect(status.lastSessionClearAt).toBe(reply.clearedAt)
})

test("real web logout clears legacy user caches while preserving unrelated cache ownership", async ({ page }) => {
  await page.goto("/react/settings")
  await expect.poll(() => page.locator("html").getAttribute("data-react-shell-ready")).toBe("true")
  const status = await workerStatus(page)

  await page.evaluate(async ({ reactCacheName }) => {
    const request = (path: string) => new Request(new URL(path, window.location.href))
    const response = (label: string) => new Response(JSON.stringify({ label }), {
      headers: { "Content-Type": "application/json" },
    })
    await (await caches.open("usernode-api-v1")).put(request("/api/auth/me"), response("current user"))
    await (await caches.open("usernode-api-v0")).put(request("/api/me/history"), response("old user"))
    await (await caches.open(reactCacheName)).put(request("/react/logout-sentinel.js"), response("shell"))
    await (await caches.open("unrelated-app-cache")).put(request("/unrelated"), response("keep"))
  }, { reactCacheName: status.cacheName })

  await page.getByRole("button", { name: "Log out" }).click()
  await expect(page.getByRole("heading", { name: "Log out of Social Vibecoding?" })).toBeVisible()
  await page.getByRole("button", { name: "Log out" }).last().click()
  await expect(page).toHaveURL(/\/react\/login$/)
  const clearedStatus = await workerStatus(page)
  expect(clearedStatus.buildRevision).toBe(status.buildRevision)
  expect(clearedStatus.lastSessionClearAt).toBeGreaterThan(status.lastSessionClearAt ?? 0)

  const remaining = await page.evaluate(async ({ reactCacheName }) => {
    const names = await caches.keys()
    const reactSentinel = names.includes(reactCacheName)
      ? await (await caches.open(reactCacheName)).match(new URL("/react/logout-sentinel.js", window.location.href).toString())
      : null
    return {
      legacyApiCaches: names.filter((name) => name.startsWith("usernode-api-")),
      reactSentinel: Boolean(reactSentinel),
      unrelated: names.includes("unrelated-app-cache"),
    }
  }, { reactCacheName: status.cacheName })
  expect(remaining).toEqual({
    legacyApiCaches: [],
    reactSentinel: true,
    unrelated: true,
  })
})

test("routes a failed cache deletion to the pending sign-out screen", async ({ page }) => {
  await page.goto("/react/settings")
  await expect.poll(() => page.locator("html").getAttribute("data-react-shell-ready")).toBe("true")
  const status = await workerStatus(page)
  await page.evaluate(async () => {
    await caches.open("usernode-api-cannot-delete")
    const originalDelete = caches.delete.bind(caches)
    Object.defineProperty(caches, "delete", {
      configurable: true,
      value(name: string) {
        return name === "usernode-api-cannot-delete"
          ? Promise.resolve(false)
          : originalDelete(name)
      },
    })
  })

  await page.getByRole("button", { name: "Log out" }).click()
  await page.getByRole("button", { name: "Log out" }).last().click()

  await expect(page).toHaveURL(/\/react\/login\?cleanup=pending$/)
  await expect(page.getByRole("heading", { level: 2, name: "Finish signing out" })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Local cleanup required")
  await expect(page.getByRole("alert")).toContainText(
    "Clear offline session data before signing in again on this device.",
  )
  await expect(page.getByRole("button", { name: "Finish cleanup" })).toBeVisible()
  expect(await page.evaluate(() => caches.has("usernode-api-cannot-delete"))).toBe(true)
  const clearedStatus = await workerStatus(page)
  expect(clearedStatus.lastSessionClearAt).toBeGreaterThan(status.lastSessionClearAt ?? 0)
})
