import { expect, test, type Locator, type Page } from "@playwright/test"

import AxeBuilder from "@axe-core/playwright"

const forum = {
  promoted: [{ id: 7, pr_number: 1, status: "promoted", yes_count: 0, no_count: 0, created_at: "2026", pr_title: "Proposal" }],
  issues: [{ id: 9, title: "Governance", kind: "rename", status: "open", up_count: 0, down_count: 0, created_at: "2026" }],
}

async function probeHitTarget(target: Locator) {
  await target.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }))
  return target.evaluate((element) => {
    const rectangle = element.getBoundingClientRect()
    const centerX = Math.floor(rectangle.left + rectangle.width / 2)
    const centerY = Math.floor(rectangle.top + rectangle.height / 2)
    const ownsPoint = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y)
      return hit === element || (hit ? element.contains(hit) : false)
    }
    const scan = (deltaX: number, deltaY: number) => {
      let distance = 0
      while (distance < 64 && ownsPoint(centerX + deltaX * (distance + 1), centerY + deltaY * (distance + 1))) {
        distance += 1
      }
      return distance
    }
    const left = scan(-1, 0)
    const right = scan(1, 0)
    const top = scan(0, -1)
    const bottom = scan(0, 1)
    return {
      effectiveHeight: top + bottom + 1,
      effectiveWidth: left + right + 1,
      visualHeight: rectangle.height,
      visualWidth: rectangle.width,
    }
  })
}

async function routeForum(page: Page) {
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: {
    app: {
      id: "recipebot",
      slug: "recipebot",
      name: "RecipeBot",
      status: "running",
      active_users: 24,
    },
  } }))
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({ json: { promoted: forum.promoted } }))
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: forum.issues } }))
}

test("proposal and governance use their canonical thread identities", async ({ page }) => {
  const discussionUrls: string[] = []
  await routeForum(page)
  await page.route("**/api/apps/recipebot/messages**", (route) => {
    discussionUrls.push(route.request().url())
    return route.fulfill({ json: { messages: [] } })
  })

  await page.goto("/react/apps/recipebot/dev/proposals/7")
  await expect(page.getByTestId("topic-discussion")).toBeVisible()
  await page.goto("/react/apps/recipebot/dev/governance/9")
  await expect(page.getByTestId("topic-discussion")).toBeVisible()

  await expect.poll(() => discussionUrls.join(" ")).toContain("thread_type=session&thread_ref=7")
  await expect.poll(() => discussionUrls.join(" ")).toContain("thread_type=governance&thread_ref=9")
})

test("loads an earlier page and keeps the current history when that page fails", async ({ page }) => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    id: 100 - index,
    username: "ava",
    content: `Message ${index}`,
    created_at: "2026-07-28T00:00:00.000Z",
  }))
  await routeForum(page)
  await page.route("**/api/apps/recipebot/messages**", (route) => {
    const before = new URL(route.request().url()).searchParams.get("before")
    return before
      ? route.fulfill({ status: 500, json: { error: "Discussion service is unavailable" } })
      : route.fulfill({ json: { messages: rows } })
  })

  await page.goto("/react/apps/recipebot/dev/proposals/7")
  await expect(page.getByRole("button", { name: "Load earlier" })).toBeVisible()
  await page.getByRole("button", { name: "Load earlier" }).click()

  await expect(page.getByTestId("topic-discussion")).toContainText("Message 0")
  await expect(page.getByTestId("topic-discussion").getByRole("alert").filter({ hasText: "Discussion unavailable" })).toContainText("Request failed (500)")
})

test("mobile topic transcript has no serious axe violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await routeForum(page)
  await page.route("**/api/apps/recipebot/messages**", (route) => route.fulfill({ json: { messages: [] } }))
  await page.goto("/react/apps/recipebot/dev/proposals/7")
  await expect(page.getByTestId("topic-discussion")).toBeVisible()

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("capability failure stays unknown and retries without navigation", async ({ page }, testInfo) => {
  let capabilityRequests = 0
  let capabilityAvailable = false
  let transcriptMounted = false
  const capabilityMethods: string[] = []
  await routeForum(page)
  await page.unroute("**/api/apps/recipebot")
  await page.route("**/api/apps/recipebot", (route) => {
    capabilityRequests += 1
    capabilityMethods.push(route.request().method())
    if (transcriptMounted && !capabilityAvailable) {
      return route.fulfill({ status: 503, json: { error: "Capability unavailable" } })
    }
    return route.fulfill({ json: { app: { id: "recipebot", slug: "recipebot", name: "RecipeBot", can_collaborate: false } } })
  })
  await page.route("**/api/apps/recipebot/messages**", (route) => {
    transcriptMounted = true
    return route.fulfill({ json: { messages: [] } })
  })

  await page.goto("/react/apps/recipebot/dev/proposals/7")
  const discussion = page.getByTestId("topic-discussion")
  const statusAlert = discussion.getByRole("alert").filter({ hasText: "Discussion status unknown" })
  await expect(statusAlert).toBeVisible()
  await expect(discussion.getByRole("alert")).toHaveCount(1)
  await expect(discussion).toContainText("Posting availability could not be confirmed.")
  const composer = discussion.getByRole("form", { name: "Post a topic discussion message" })
  await expect(composer).toHaveAttribute("aria-disabled", "true")
  await expect(composer.getByRole("textbox", { name: "Discussion message" })).toBeDisabled()
  const retry = statusAlert.getByRole("button", { name: "Retry" })
  const hitTarget = await probeHitTarget(retry)
  const coarsePointer = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)
  expect(hitTarget.visualHeight).toBeLessThan(48)
  if (coarsePointer) {
    expect(hitTarget.effectiveHeight).toBeGreaterThanOrEqual(48)
    expect(hitTarget.effectiveWidth).toBeGreaterThanOrEqual(48)
    const retryBox = await retry.boundingBox()
    expect(retryBox).not.toBeNull()
    const requestsBeforeExpandedHit = capabilityRequests
    await page.mouse.click(retryBox!.x + retryBox!.width / 2, retryBox!.y - 4)
    await expect.poll(() => capabilityRequests).toBe(requestsBeforeExpandedHit + 1)
  } else {
    expect(hitTarget.effectiveHeight).toBeLessThan(48)
  }
  if (process.env.STATUS_REPRESENTATIVE_CAPTURE_DIR) {
    await page.screenshot({
      fullPage: true,
      path: `${process.env.STATUS_REPRESENTATIVE_CAPTURE_DIR}/status-unknown-after-${testInfo.project.name}.png`,
    })
  }

  const urlBeforeRetry = page.url()
  const requestsBeforeRetry = capabilityRequests
  capabilityAvailable = true
  await retry.click()
  await expect.poll(() => capabilityRequests).toBe(requestsBeforeRetry + 1)
  expect(capabilityMethods).toEqual(Array.from({ length: capabilityRequests }, () => "GET"))
  expect(page.url()).toBe(urlBeforeRetry)
  await expect(discussion.getByRole("note").filter({ hasText: "View-only discussion" })).toBeVisible()
  await expect(discussion.getByRole("alert")).toHaveCount(0)
})

test("confirmed view-only empty discussion names the permission state", async ({ page }, testInfo) => {
  await routeForum(page)
  await page.route("**/api/apps/recipebot/messages**", (route) => route.fulfill({ json: { messages: [] } }))

  await page.goto("/react/apps/recipebot/dev/proposals/7")
  const discussion = page.getByTestId("topic-discussion")
  await expect(discussion.getByRole("note").filter({ hasText: "View-only discussion" })).toBeVisible()
  await expect(discussion).toContainText("Posting is unavailable for this view-only discussion.")
  await expect(discussion).not.toContainText("Start the conversation below.")
  if (process.env.STATUS_REPRESENTATIVE_CAPTURE_DIR) {
    await page.screenshot({
      fullPage: true,
      path: `${process.env.STATUS_REPRESENTATIVE_CAPTURE_DIR}/status-view-only-after-${testInfo.project.name}.png`,
    })
  }
})
