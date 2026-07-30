import { expect, test, type Page } from "@playwright/test"

import AxeBuilder from "@axe-core/playwright"

const forum = {
  promoted: [{ id: 7, pr_number: 1, status: "promoted", yes_count: 0, no_count: 0, created_at: "2026", pr_title: "Proposal" }],
  issues: [{ id: 9, title: "Governance", kind: "rename", status: "open", up_count: 0, down_count: 0, created_at: "2026" }],
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
