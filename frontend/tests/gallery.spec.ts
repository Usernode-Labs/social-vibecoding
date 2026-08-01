import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const beforePng = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const afterPng = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const recording = "cccccccccccccccccccccccccccccccc"
const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl2gAAAAASUVORK5CYII=", "base64")
const webmBytes = Buffer.from("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHwEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggHa7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDBEiYhARAAAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIk0OUqTpMw/CcgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QCYloA4JCwgRC6gRCagQJVsIRVuYEBElTDZ0B/c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2Mi4zLjEwMHNz2mPAi2PFiJNDlKk6TMPwZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4xMS4xMDAgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMDQwMDAwMDAwAB9DtnWt54EAo6iBAACAgkmDQgAA8AD2ADgkHBhKAAAgIABNs//8uQz///60EH/9gDGAHFO7a5G7j7OBALeK94EB8YIBqPCBAw==", "base64")

const apps = [{ id: 1, slug: "recipebot", name: "RecipeBot", proposal_count: 2 }]
const stats = {
  total: 2,
  complete: 1,
  missing_recording: 1,
  missing_before: 0,
  before_fell_back: 0,
  root_only: 1,
  failed_or_skipped: 0,
}

const firstProposal = {
  id: 41,
  mergedAt: "2026-07-27T12:00:00.000Z",
  prNumber: 81,
  prUrl: "https://github.com/Usernode-Labs/social-vibecoding/pull/81",
  title: "Make recipe search more useful",
  appId: 1,
  appSlug: "recipebot",
  appName: "RecipeBot",
  captureState: "captured",
  visuals: {
    captures: [{
      index: 0,
      path: "/search",
      viewport: "mobile",
      before: { png: beforePng },
      after: { png: afterPng, webm: recording },
    }],
  },
}

const olderProposal = {
  id: 40,
  mergedAt: "2026-07-26T12:00:00.000Z",
  title: "Keep an explicit empty capture outcome",
  appId: 1,
  appSlug: "recipebot",
  appName: "RecipeBot",
  captureState: "console_only",
  captureReason: "No visual change expected.",
  visuals: null,
}

async function installGalleryFixture(page: import("@playwright/test").Page) {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: false } } }))
  await page.route("**/api/gallery/apps", (route) => route.fulfill({ json: { apps } }))
  await page.route("**/api/gallery/stats**", (route) => route.fulfill({ json: { stats } }))
  await page.route("**/api/gallery/proposals**", (route) => {
    const requestUrl = new URL(route.request().url())
    const before = requestUrl.searchParams.get("before")
    const beforeId = requestUrl.searchParams.get("before_id")
    if (before === "2026-07-27T12:00:00.000Z" && beforeId === "41") {
      return route.fulfill({ json: { proposals: [olderProposal], hasMore: false, nextCursor: null } })
    }
    return route.fulfill({ json: {
      proposals: [firstProposal],
      hasMore: true,
      nextCursor: { before: "2026-07-27T12:00:00.000Z", before_id: 41 },
    } })
  })
  await page.route("**/visuals/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()
    return id === recording
      ? route.fulfill({ body: webmBytes, contentType: "video/webm" })
      : route.fulfill({ body: pngBytes, contentType: "image/png" })
  })
}

test("renders the any-admin metadata index without proxying visual bytes", async ({ page }) => {
  await installGalleryFixture(page)
  await page.goto("/react/admin/gallery")

  const gallery = page.getByTestId("admin-gallery")
  await expect(gallery).not.toHaveClass(/(?:mx-auto|max-w-)/)
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "Screenshot gallery" })).toHaveCount(1)
  await expect(gallery).toContainText("Make recipe search more useful")
  await expect(gallery).toContainText("Complete")
  await expect(gallery).toContainText("Matching proposals")
  const galleryLink = gallery.getByRole("link", { name: "Open gallery" })
  await expect(galleryLink).toHaveAttribute("data-slot", "action-anchor")
  await expect(galleryLink).toHaveAttribute("href", "/gallery")
  const improveApp = gallery.getByRole("link", { name: "Improve app" })
  await expect(improveApp).toHaveAttribute("data-slot", "action-link")
  await expect(improveApp).toHaveAttribute("href", "/react/apps/recipebot/dev")
  const openProposal = gallery.getByRole("link", { name: "Open proposal" })
  await expect(openProposal).toHaveAttribute("data-slot", "action-link")
  await expect(openProposal).toHaveAttribute("href", "/react/apps/recipebot/dev/proposals/41")
  const pullRequest = gallery.getByRole("link", { name: "PR #81" })
  await expect(pullRequest).toHaveAttribute("data-slot", "action-anchor")
  await expect(pullRequest).toHaveAttribute("href", firstProposal.prUrl)
  await expect(pullRequest).toHaveAttribute("target", "_blank")
  await expect(pullRequest).toHaveAttribute("rel", "noopener noreferrer")
  await expect(gallery.getByRole("img", { name: "Before /search · mobile" })).toHaveAttribute("src", `/visuals/${beforePng}`)
  await expect(gallery.locator("video[aria-label='After /search · mobile']")).toHaveAttribute("src", `/visuals/${recording}`)
  await expect(gallery.locator('[data-media-readiness="ready"]')).toHaveCount(2)
  await expect(gallery.getByTestId("gallery-capture-state-41")).toHaveText("Captured")
})

test("keeps gallery destinations absent when a proposal has no app slug", async ({ page }) => {
  await installGalleryFixture(page)
  await page.unroute("**/api/gallery/proposals**")
  await page.route("**/api/gallery/proposals**", (route) => route.fulfill({ json: {
    proposals: [{ ...olderProposal, appSlug: null }],
    hasMore: false,
    nextCursor: null,
  } }))
  await page.goto("/react/admin/gallery")

  const gallery = page.getByTestId("admin-gallery")
  await expect(gallery.getByRole("button", { name: "Improve app" })).toBeDisabled()
  await expect(gallery.getByRole("button", { name: "Open proposal" })).toBeDisabled()
  await expect(gallery.getByRole("link", { name: "Improve app" })).toHaveCount(0)
  await expect(gallery.getByRole("link", { name: "Open proposal" })).toHaveCount(0)
})

test("keeps Captured hidden until declared media bytes are ready", async ({ page }) => {
  await installGalleryFixture(page)
  await page.unroute("**/visuals/*")
  let releaseBytes = () => {}
  const bytesReady = new Promise<void>((resolve) => { releaseBytes = resolve })
  const requests: string[] = []
  await page.route("**/visuals/*", async (route) => {
    requests.push(route.request().url())
    await bytesReady
    const id = new URL(route.request().url()).pathname.split("/").pop()
    await (id === recording
      ? route.fulfill({ body: webmBytes, contentType: "video/webm" })
      : route.fulfill({ body: pngBytes, contentType: "image/png" }))
  })
  await page.goto("/react/admin/gallery", { waitUntil: "domcontentloaded" })

  await expect(page.getByText("Make recipe search more useful")).toBeVisible()
  await expect(page.locator('[data-media-readiness="loading"]')).toHaveCount(2)
  await expect(page.getByTestId("gallery-capture-state-41")).toHaveCount(0)
  await expect.poll(() => requests.map((url) => new URL(url).pathname).sort()).toEqual([`/visuals/${beforePng}`, `/visuals/${afterPng}`, `/visuals/${recording}`].sort())

  releaseBytes()
  await expect(page.locator('[data-media-readiness="ready"]')).toHaveCount(2)
  await expect(page.getByTestId("gallery-capture-state-41")).toHaveText("Captured")
})

test("shows a negative in-tile failure and retries immutable image bytes", async ({ page }) => {
  await installGalleryFixture(page)
  await page.unroute("**/api/gallery/proposals**")
  await page.route("**/api/gallery/proposals**", (route) => route.fulfill({ json: {
    proposals: [{ ...firstProposal, visuals: { captures: [{ index: 0, path: "/search", viewport: "mobile", before: null, after: { png: afterPng } }] } }],
    hasMore: false,
    nextCursor: null,
  } }))
  await page.unroute("**/visuals/*")
  const requests: string[] = []
  await page.route("**/visuals/*", (route) => {
    requests.push(route.request().url())
    return requests.length === 1
      ? route.fulfill({ status: 404, body: "missing" })
      : route.fulfill({ body: pngBytes, contentType: "image/png" })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/admin/gallery")

  const alert = page.getByRole("alert").filter({ hasText: "After visual didn’t load" })
  await expect(alert).toContainText("The stored media could not be opened.")
  await expect(page.getByTestId("gallery-capture-state-41")).toHaveCount(0)
  await alert.getByRole("button", { name: "Retry" }).click()

  await expect(page.locator('[data-media-readiness="ready"]')).toHaveCount(1)
  await expect(page.getByTestId("gallery-capture-state-41")).toHaveText("Captured")
  expect(new URL(requests[0]).pathname).toBe(`/visuals/${afterPng}`)
  expect(new URL(requests[1]).searchParams.get("retry")).toBe("1")
})

test("falls back from a failed recording to a proven still", async ({ page }) => {
  await installGalleryFixture(page)
  await page.unroute("**/visuals/*")
  const requests: string[] = []
  await page.route("**/visuals/*", (route) => {
    const url = new URL(route.request().url())
    requests.push(url.pathname)
    return url.pathname === `/visuals/${recording}`
      ? route.fulfill({ status: 404, body: "missing" })
      : route.fulfill({ body: pngBytes, contentType: "image/png" })
  })
  await page.goto("/react/admin/gallery")

  await expect(page.getByText("Recording unavailable")).toBeVisible()
  await expect(page.locator('[data-media-readiness="ready"]')).toHaveCount(2)
  await expect(page.getByTestId("gallery-capture-state-41")).toHaveText("Captured")
  expect(requests).toContain(`/visuals/${recording}`)
  expect(requests).toContain(`/visuals/${afterPng}`)
})

test("reports a failed recording when its poster cannot become a fallback", async ({ page }) => {
  await installGalleryFixture(page)
  await page.unroute("**/visuals/*")
  await page.route("**/visuals/*", (route) => {
    const path = new URL(route.request().url()).pathname
    return path === `/visuals/${beforePng}`
      ? route.fulfill({ body: pngBytes, contentType: "image/png" })
      : route.fulfill({ status: 404, body: "missing" })
  })
  await page.goto("/react/admin/gallery")

  await expect(page.getByRole("alert").filter({ hasText: "After visual didn’t load" })).toContainText("The stored media could not be opened.")
  await expect(page.getByText("Recording unavailable")).toBeVisible()
  await expect(page.getByTestId("gallery-capture-state-41")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible()
})

test("does not claim Captured for an invalid artifact reference", async ({ page }) => {
  await installGalleryFixture(page)
  await page.unroute("**/api/gallery/proposals**")
  await page.route("**/api/gallery/proposals**", (route) => route.fulfill({ json: {
    proposals: [{ ...firstProposal, visuals: { captures: [{ index: 0, path: "/search", viewport: null, before: null, after: { png: "not-a-visual-id" } }] } }],
    hasMore: false,
    nextCursor: null,
  } }))
  await page.goto("/react/admin/gallery")

  await expect(page.getByRole("alert")).toContainText("The stored artifact reference is invalid.")
  await expect(page.getByTestId("gallery-capture-state-41")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0)
})

test("preserves keyset paging and keeps captured proposals visible if the older page fails", async ({ page }) => {
  await installGalleryFixture(page)
  await page.goto("/react/admin/gallery")
  await expect(page.getByText("Make recipe search more useful")).toBeVisible()

  await page.unroute("**/api/gallery/proposals**")
  let olderRequest: URL | null = null
  await page.route("**/api/gallery/proposals**", (route) => {
    olderRequest = new URL(route.request().url())
    return route.fulfill({ status: 500, json: { error: "Capture index offline" } })
  })
  await page.getByRole("button", { name: "Load older" }).click()
  await expect.poll(() => olderRequest?.searchParams.get("before")).toBe("2026-07-27T12:00:00.000Z")
  await expect.poll(() => olderRequest?.searchParams.get("before_id")).toBe("41")
  await expect(page.getByRole("status")).toContainText("Older proposals could not be loaded")
  await expect(page.getByText("Make recipe search more useful")).toBeVisible()
})

test("sends only the existing server filter query", async ({ page }) => {
  const appQueries: string[] = []
  await installGalleryFixture(page)
  await page.unroute("**/api/gallery/proposals**")
  await page.route("**/api/gallery/proposals**", (route) => {
    appQueries.push(route.request().url())
    return route.fulfill({ json: { proposals: [], hasMore: false, nextCursor: null } })
  })

  await page.goto("/react/admin/gallery")
  await page.getByRole("combobox", { name: "Filter by app" }).click()
  await page.getByRole("option", { name: "RecipeBot (2)" }).click()
  await page.getByRole("button", { name: "Apply filters" }).click()

  await expect.poll(() => appQueries.some((url) => new URL(url).searchParams.get("app") === "recipebot")).toBe(true)
})

test("keeps the access gate and API failure explicit", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: false } } }))
  await page.goto("/react/admin/gallery")
  await expect(page.getByRole("alert")).toContainText("Admin access required")

  await page.unroute("**/api/auth/me")
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true } } }))
  await page.route("**/api/gallery/apps", (route) => route.fulfill({ json: { apps: [] } }))
  await page.route("**/api/gallery/stats**", (route) => route.fulfill({ json: { stats } }))
  await page.route("**/api/gallery/proposals**", (route) => route.fulfill({ status: 503, json: { error: "gallery unavailable" } }))
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("Screenshot gallery unavailable")
  await expect(page.getByRole("alert")).toContainText("gallery unavailable")
})

test("stays legible and accessible on a mobile viewport", async ({ page }) => {
  await installGalleryFixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/admin/gallery")

  const gallery = page.getByTestId("admin-gallery")
  await expect(gallery.getByRole("button", { name: "Refresh" })).toBeVisible()
  await expect(gallery.getByRole("combobox", { name: "Filter by app" })).toBeVisible()
  expect(await gallery.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
