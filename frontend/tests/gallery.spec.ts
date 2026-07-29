import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const beforePng = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const afterPng = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const recording = "cccccccccccccccccccccccccccccccc"

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
}

test("renders the any-admin metadata index without proxying visual bytes", async ({ page }) => {
  await installGalleryFixture(page)
  await page.goto("/react/admin/gallery")

  const gallery = page.getByTestId("admin-gallery")
  await expect(gallery).toContainText("Make recipe search more useful")
  await expect(gallery).toContainText("Complete")
  await expect(gallery).toContainText("Matching proposals")
  await expect(gallery.getByRole("link", { name: "Open legacy gallery" })).toHaveAttribute("href", "/gallery")
  await expect(gallery.getByRole("link", { name: "Open app Dev" })).toHaveAttribute("href", "/react/apps/recipebot/dev")
  await expect(gallery.getByRole("link", { name: "Open proposal" })).toHaveAttribute("href", "/react/apps/recipebot/dev/proposals/41")
  await expect(gallery.getByRole("img", { name: "Before /search · mobile" })).toHaveAttribute("src", `/visuals/${beforePng}`)
  await expect(gallery.locator("video[aria-label='After /search · mobile']")).toHaveAttribute("src", `/visuals/${recording}`)
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
