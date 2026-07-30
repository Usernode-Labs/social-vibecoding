import { readFileSync } from "node:fs"

import { expect, test, type Page } from "@playwright/test"

import { expectAccessibleShellStructure } from "./accessibility"

const apps = {
  apps: [
    {
      id: "recipebot", slug: "recipebot", name: "RecipeBot", status: "running",
      tagline: "Find a recipe for what you have at home", description: null,
      active_users: 24, is_favorited: true, is_collaborator: true,
      your_apps_hidden: false, favorite_order: 0, open_prs: 0,
      active_sessions: 0, open_issues: 0, icon_url: null,
    },
    {
      id: "game-corner", slug: "game-corner", name: "Game Corner", status: "building",
      tagline: "A daily puzzle for the community", description: null,
      active_users: 8, is_favorited: false, is_collaborator: false,
      your_apps_hidden: false, favorite_order: null, open_prs: 0,
      active_sessions: 0, open_issues: 0, icon_url: null,
    },
    {
      id: "pantry-planner", slug: "pantry-planner", name: "Pantry Planner", status: "running",
      tagline: "Keep ingredients organised", description: null,
      active_users: 6, is_favorited: true, is_collaborator: false,
      your_apps_hidden: false, favorite_order: 1, open_prs: 0,
      active_sessions: 0, open_issues: 0, icon_url: null,
    },
  ],
}

async function installShortcutBridge(
  page: Page,
  result: { added: true; mechanism: "pinned-shortcut" | "widget" } | { error: string }
) {
  const shortcutResult = JSON.stringify(result).replaceAll("<", "\\u003c")
  const hostedBridge = readFileSync(new URL("../../public/usernode-bridge.js", import.meta.url), "utf8")
  await page.addInitScript({ content: `
    {
    const shortcutResult = ${shortcutResult};
    Object.defineProperty(window, "Usernode", {
      configurable: true,
      value: {
        postMessage(message) {
          const envelope = JSON.parse(message);
          window.__shortcutNativeEnvelopes = [
            ...(window.__shortcutNativeEnvelopes || []),
            envelope,
          ];
          let value = null;
          let error = null;
          if (envelope.method === "getBridgeInfo") {
            value = {
              version: 3,
              capabilities: ["getHomeScreenShortcutSupport", "addHomeScreenShortcut"],
            };
          } else if (envelope.method === "getHomeScreenShortcutSupport") {
            value = {
              mechanism: "error" in shortcutResult ? "pinned-shortcut" : shortcutResult.mechanism,
            };
          } else if (envelope.method === "addHomeScreenShortcut") {
            window.__shortcutNativeResult = shortcutResult;
            if ("error" in shortcutResult) error = shortcutResult.error;
            else value = shortcutResult;
          }
          window.setTimeout(
            () => window.__usernodeResolve?.(envelope.id, value, error),
            0
          );
        },
      },
    });
    }
    ${hostedBridge}
  ` })
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "ava", canAdminWrite: true } } }))
  await page.route("**/api/apps", (route) => route.fulfill({ json: apps }))
  await page.route((url) => url.pathname === "/api/notifications", (route) => route.fulfill({
    json: { notifications: [], unread: 0, pendingInvites: [], hasMore: false, nextBefore: null },
  }))
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: {
    app: { ...apps.apps[0], view_visibility: "public", can_manage: true, url: "https://recipebot.example.test" },
  } }))
  await page.route("**/api/public/apps/recipebot/contributors?include_wallets=0", (route) => route.fulfill({ json: {
    contributors: [{ user_id: 7, username: "ava" }, { user_id: 12, username: "lin" }],
  } }))
  await page.route("**/api/iframe-token*", (route) => {
    if (new URL(route.request().url()).searchParams.get("app") !== "recipebot") {
      return route.fulfill({ status: 400, json: { error: "app query parameter is required" } })
    }
    return route.fulfill({ json: { token: "header.payload.signature" } })
  })
  await page.route("https://recipebot.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><title>RecipeBot</title><main>RecipeBot child app</main>",
  }))
})

test("keeps personal launching on Home and catalog discovery in Explore", async ({ page }) => {
  await page.goto("/react/")

  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible()
  const yours = page.getByRole("region", { name: "Your apps" })
  await expect(yours.getByTestId("home-app-shortcut-recipebot")).toContainText("RecipeBot")
  await expect(yours.getByTestId("home-app-shortcut-pantry-planner")).toContainText("Pantry Planner")
  await expect(page.getByTestId("home-app-shortcut-game-corner")).toHaveCount(0)
  await expect(yours.getByRole("link", { name: "Open RecipeBot" })).toHaveAttribute("href", "/react/apps/recipebot/open")

  await page.goto("/react/explore")
  await expect(page.getByRole("heading", { name: "Explore", exact: true })).toBeVisible()
  await expect(page.getByTestId("explore-app-card-recipebot")).toContainText("RecipeBot")
  await expect(page.getByTestId("explore-app-card-game-corner")).toContainText("Game Corner")
  await expect(page.getByRole("link", { name: "View details for RecipeBot" })).toHaveAttribute("href", "/react/apps/recipebot")
})

test("previews at most three unresolved Activity items without duplicating Work", async ({ page }) => {
  await page.unroute((url) => url.pathname === "/api/notifications")
  await page.route((url) => url.pathname === "/api/notifications", (route) => route.fulfill({
    json: {
      pendingInvites: [{
        kind: "collab",
        appId: 11,
        appSlug: "recipebot",
        appName: "RecipeBot",
        invitedBy: "lin",
        createdAt: "2026-07-29T10:00:00Z",
      }],
      notifications: [
        { id: 1, kind: "mention", readAt: null, appId: 11, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-29T09:00:00Z", messageContent: "Can we add pantry filters?", sourceUsername: "ava" },
        { id: 2, kind: "reply", readAt: null, appId: 11, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-29T08:00:00Z", messageContent: "A reply worth reading", sourceUsername: "sam" },
        { id: 3, kind: "reaction", readAt: null, appId: 11, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-29T07:00:00Z", messageContent: "A fourth bell item", sourceUsername: "tay" },
        { id: 4, kind: "session_done", readAt: null, appId: 11, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-29T06:00:00Z", messageContent: "Builder session finished", sourceUsername: null },
      ],
      unread: 5,
      hasMore: false,
      nextBefore: null,
    },
  }))

  await page.goto("/react/")

  const activity = page.getByRole("region", { name: "Needs attention" })
  await expect(activity.getByRole("listitem")).toHaveCount(3)
  await expect(activity).toContainText("Collaborator invitation")
  await expect(activity).toContainText("Can we add pantry filters?")
  await expect(activity).not.toContainText("Builder session finished")
  await expect(activity.getByRole("link", { name: "View all activity" })).toHaveAttribute("href", "/react/notifications")
})

test("keeps Home shortcuts available when Activity cannot load", async ({ page }) => {
  await page.unroute((url) => url.pathname === "/api/notifications")
  await page.route((url) => url.pathname === "/api/notifications", (route) =>
    route.fulfill({ status: 503, json: { error: "Activity is unavailable" } }),
  )

  await page.goto("/react/")

  await expect(page.getByRole("region", { name: "Your apps" }).getByRole("link", { name: "Open RecipeBot" })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Activity couldn’t load")
})

test("uses the detail view for primary app destinations", async ({ page }) => {
  await page.goto("/react/apps/recipebot")

  const details = page.getByTestId("app-details")
  const chrome = page.getByTestId("app-context-chrome")
  await expect(details).toContainText("RecipeBot")
  await expect(chrome.getByRole("group", { name: "RecipeBot controls" })).toHaveAttribute("data-placement", "flow")
  await expect(details.locator("h1")).toHaveCount(1)
  await expect(details.getByRole("heading", { level: 1, name: "RecipeBot" })).toBeVisible()
  await expect.poll(() => details.evaluate((element) => getComputedStyle(element).maxWidth)).toBe("none")
  await expect(chrome.getByRole("button", { name: "Improve" })).toBeVisible()
  await expect(chrome.getByRole("button", { name: "Use" })).toHaveCount(0)
  await expect(chrome.getByRole("button", { name: "Close RecipeBot" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Open RecipeBot" })).toHaveAttribute("href", "/react/apps/recipebot/open")
  await expect(page.getByRole("link", { name: "Improve RecipeBot" })).toHaveAttribute("href", "/react/apps/recipebot/dev")
  await expect(page.getByTestId("app-actions")).toHaveAttribute("role", "group")
  await expect(page.getByRole("button", { name: "Remove from Your apps" })).toBeVisible()
  await expect(page.getByRole("list", { name: "RecipeBot contributors" })).toContainText("@ava")
  await expect(page.getByRole("list", { name: "RecipeBot contributors" })).toContainText("@lin")
})

test("posts the exact v1 shortcut envelope from App Details and reports the native result", async ({ page }) => {
  await installShortcutBridge(page, { added: true, mechanism: "pinned-shortcut" })
  await page.goto("/react/apps/recipebot")

  await expect(page.getByRole("button", { name: "Add to phone home screen" })).toBeVisible()
  await page.getByRole("button", { name: "Add to phone home screen" }).click()
  await expect(page.getByRole("status")).toContainText("RecipeBot was added to your phone home screen.")

  const evidence = await page.evaluate(() => {
    const state = window as Window & {
      __shortcutNativeEnvelopes?: Array<Record<string, unknown>>
      __shortcutNativeResult?: unknown
    }
    return {
      envelope: state.__shortcutNativeEnvelopes?.find(({ method }) => method === "addHomeScreenShortcut"),
      result: state.__shortcutNativeResult,
      origin: window.location.origin,
    }
  })
  expect(evidence.envelope).toEqual({
    method: "addHomeScreenShortcut",
    id: expect.stringMatching(/^\d+-[0-9a-f]+$/),
    args: {
      contract: "usernode.app-shortcut",
      contract_version: 1,
      route_contract: "usernode.react-app-open.v1",
      name: "RecipeBot",
      url: `${evidence.origin}/react/apps/recipebot/open`,
      icon_url: null,
      identity: {
        contract: "usernode.app-identity",
        contract_version: 1,
        hash_algorithm: "fnv1a64",
        identity_key: "id:recipebot",
        identity_hash: "fnv1a64:3d56ed8b0c8b03e7",
        appearance_hash: "fnv1a64:ffa6992d62eba3de",
        slot: 3,
        display_name: "RecipeBot",
        monogram: "R",
        artwork_ref: null,
      },
      silent: false,
    },
  })
  expect(evidence.result).toEqual({ added: true, mechanism: "pinned-shortcut" })
})

test("gates the shortcut action on native capability and reports native failure", async ({ page }) => {
  await page.goto("/react/apps/recipebot")
  await expect(page.getByRole("button", { name: /Add to .*home screen|Add to Usernode widget/ })).toHaveCount(0)

  await installShortcutBridge(page, { error: "The shortcut request was denied." })
  await page.reload()
  await page.getByRole("button", { name: "Add to phone home screen" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Shortcut wasn't added" }))
    .toContainText("The shortcut request was denied.")
})

test("routes the detail chrome to Improve and closes its app context to Home", async ({ page }) => {
  await page.goto("/react/apps/recipebot")
  await page.getByTestId("app-context-chrome").getByRole("button", { name: "Improve" }).click()
  await expect(page).toHaveURL("/react/apps/recipebot/dev")

  await page.goto("/react/apps/recipebot")
  await page.getByTestId("app-context-chrome").getByRole("button", { name: "Close RecipeBot" }).click()
  await expect(page).toHaveURL(/\/react\/?$/)
})

test("does not invent app identity when app detail access fails", async ({ page }) => {
  await page.unroute("**/api/apps/recipebot")
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ status: 404, json: { error: "App not found" } }))
  await page.goto("/react/apps/recipebot")

  const details = page.getByTestId("app-details")
  await expect(details.getByRole("alert")).toContainText("App unavailable")
  await expect(details.getByTestId("app-context-chrome")).toHaveCount(0)
  await expect(details.locator("h1")).toHaveCount(0)
})

test("shares the canonical bare app URL from the app detail action hub", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          localStorage.setItem("copied-app-url", value)
        },
      },
    })
  })

  await page.goto("/react/apps/recipebot")
  await page.getByRole("button", { name: "Share RecipeBot" }).click()

  await expect(page.getByRole("heading", { name: "Share RecipeBot" })).toBeVisible()
  await expect(page.getByText("Anyone with this link can open the app outside Usernode. Some visitors may need to sign in.", { exact: true })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "App link" })).toHaveValue("https://recipebot.example.test")
  await expect(page.getByRole("link", { name: "Open in new tab" })).toHaveAttribute("href", "https://recipebot.example.test")

  await page.getByRole("button", { name: "Copy link" }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("copied-app-url"))).toBe("https://recipebot.example.test")
  await expect(page.getByRole("status")).toContainText("Link copied")
})

test("uses the canonical server result when a full administrator changes the approval lock", async ({ page }) => {
  let lockRequest: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/lock", async (route) => {
    lockRequest = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ json: { ok: true, locked: true } })
  })

  await page.goto("/react/apps/recipebot")
  await page.getByRole("button", { name: "Require an admin approval" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("Require an admin approval?")
  await page.getByRole("button", { name: "Require approval" }).click()

  await expect.poll(() => lockRequest).toEqual({ method: "POST", body: { locked: true } })
  await expect(page.getByText("This app is locked. Community-approved changes also need an administrator yes vote before they can merge.")).toBeVisible()
  await expect(page.getByTestId("app-details").getByRole("button", { name: "Unlock changes" })).toBeVisible()
})

test("creates an app-rename proposal through the existing manifest PR contract", async ({ page }) => {
  let request: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/rename", async (route) => {
    request = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ status: 201, json: { ok: true, sessionId: 71, prNumber: 15 } })
  })

  await page.goto("/react/apps/recipebot")
  await page.getByRole("button", { name: "Rename" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("Propose a new app name")
  await page.getByRole("textbox", { name: "New name" }).fill("RecipeLab")
  await page.getByRole("button", { name: "Create rename proposal" }).click()

  await expect.poll(() => request).toEqual({ method: "POST", body: { newName: "RecipeLab" } })
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev\/sessions\/71$/)
})

test("keeps a failed app-rename proposal open and reports the server error", async ({ page }) => {
  await page.route("**/api/apps/recipebot/rename", (route) => route.fulfill({ status: 409, json: { error: "A rename proposal is already up for vote" } }))
  await page.goto("/react/apps/recipebot")
  await page.getByRole("button", { name: "Rename" }).click()
  await page.getByRole("textbox", { name: "New name" }).fill("RecipeLab")
  await page.getByRole("button", { name: "Create rename proposal" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("A rename proposal is already up for vote")
  await expect(page.getByRole("button", { name: "Create rename proposal" })).toBeEnabled()
})

test("does not expose the direct lock mutation to a non-write administrator", async ({ page }) => {
  await page.unroute("**/api/auth/me")
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "ava", canAdminWrite: false } } }))
  await page.goto("/react/apps/recipebot")
  await expect(page.getByRole("button", { name: "Require an admin approval" })).toHaveCount(0)
  await expect(page.getByText("Change approval")).toHaveCount(0)
})

test("saves an app from its detail action hub and reflects the server-confirmed state", async ({ page }) => {
  let favoriteRequest: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/game-corner/favorite", async (route) => {
    favoriteRequest = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ json: { ok: true, is_favorited: true } })
  })

  await page.unroute("**/api/apps/recipebot")
  await page.route("**/api/apps/game-corner", (route) => route.fulfill({ json: {
    app: { ...apps.apps[1], view_visibility: "public", can_manage: false, url: "https://game-corner.example.test" },
  } }))
  await page.route("**/api/public/apps/game-corner/contributors?include_wallets=0", (route) => route.fulfill({ json: { contributors: [] } }))
  await page.goto("/react/apps/game-corner")
  await page.getByRole("button", { name: "Save to Your apps" }).click()

  await expect.poll(() => favoriteRequest).toEqual({ method: "POST", body: { favorited: true } })
  await expect(page.getByRole("button", { name: "Remove from Your apps" })).toBeVisible()
  await expect(page.getByText("Game Corner was saved to Your apps.")).toBeAttached()
})

test("keeps the app state and explains a favorite server error", async ({ page }) => {
  await page.unroute("**/api/apps/recipebot")
  await page.route("**/api/apps/game-corner", (route) => route.fulfill({ json: {
    app: { ...apps.apps[1], view_visibility: "public", can_manage: false, url: "https://game-corner.example.test" },
  } }))
  await page.route("**/api/public/apps/game-corner/contributors?include_wallets=0", (route) => route.fulfill({ json: { contributors: [] } }))
  await page.route("**/api/apps/game-corner/favorite", (route) => route.fulfill({ status: 500, json: { error: "Saved apps are temporarily unavailable" } }))
  await page.goto("/react/apps/game-corner")
  await page.getByRole("button", { name: "Save to Your apps" }).click()

  await expect(page.getByRole("alert")).toContainText("Saved apps are temporarily unavailable")
  await expect(page.getByRole("button", { name: "Save to Your apps" })).toBeVisible()
})

test("keeps detail actions usable on a phone-sized viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/apps/recipebot")
  await expect(page.getByRole("button", { name: "Remove from Your apps" })).toBeVisible()
})

test("hosts a running child app with the preserved iframe safety contract", async ({ page }) => {
  await page.goto("/react/apps/recipebot/open?path=/recipes?query=tomato")

  const frame = page.getByTestId("focused-app-frame")
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock")
  const source = await frame.getAttribute("src")
  expect(source).toContain("https://recipebot.example.test/recipes?query=tomato&token=header.payload.signature")
})

test("shows the lazy developer console only for messages from the active child frame", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("usernode:devConsoleMode", "always"))
  await page.goto("/react/apps/recipebot/open")
  await expect(page.getByRole("button", { name: "Open developer console" })).toBeVisible()

  await page.evaluate(() => window.postMessage({
    sentinel: "__usernodeDevConsole",
    level: "error",
    args: ["spoofed top-frame error"],
    ts: Date.now(),
  }, "*"))

  await expect.poll(() => page.frames().some((frame) => frame.url().startsWith("https://recipebot.example.test/"))).toBe(true)
  const child = page.frames().find((frame) => frame.url().startsWith("https://recipebot.example.test/"))
  if (!child) throw new Error("RecipeBot child frame did not load")
  await child.evaluate(() => window.parent.postMessage({
    sentinel: "__usernodeDevConsole",
    level: "error",
    args: ["Recipe query failed", { status: 503 }],
    source: "recipe-client.js",
    line: 42,
    col: 8,
    url: window.location.href,
    ts: Date.now(),
  }, "*"))

  await expect(page.getByRole("button", { name: "Open developer console, errors" })).toBeVisible()
  await page.getByRole("button", { name: "Open developer console, errors" }).click()
  await expect(page.getByRole("heading", { name: "Developer console" })).toBeVisible()
  await expect(page.getByText("Recipe query failed")).toBeVisible()
  await expect(page.getByText("spoofed top-frame error")).toHaveCount(0)
  await page.getByRole("button", { name: "Clear", exact: true }).click()
  await expect(page.getByText("No console messages yet")).toBeVisible()
})

test("does not expose the developer console without an active frame", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("usernode:devConsoleMode", "always"))
  await page.goto("/react/")
  await expect(page.getByRole("button", { name: "Open developer console" })).toHaveCount(0)
})

test("rejects an unsafe child-app deep link before it reaches the iframe", async ({ page }) => {
  await page.goto("/react/apps/recipebot/open?path=//untrusted.example.test")

  const source = await page.getByTestId("focused-app-frame").getAttribute("src")
  expect(source).toBe("https://recipebot.example.test/?token=header.payload.signature")
})

test("filters by a user-facing app name", async ({ page }) => {
  await page.goto("/react/explore")
  await page.getByRole("searchbox", { name: "Search dApps" }).fill("recipe")

  await expect(page.getByTestId("explore-app-card-recipebot")).toBeVisible()
  await expect(page.getByTestId("explore-app-card-game-corner")).not.toBeVisible()
})

test("does not duplicate the catalog on Home", async ({ page }) => {
  await page.goto("/react/")
  await expect(page.getByRole("region", { name: "Your apps" }).getByTestId("home-app-shortcut-recipebot")).toBeVisible()
  await expect(page.getByRole("heading", { name: "All dApps" })).toHaveCount(0)
  await expect(page.getByRole("searchbox", { name: "Search dApps" })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Explore dApps" })).toHaveAttribute("href", "/react/explore")
})

test("reorders the complete personal app rail through the canonical order contract", async ({ page }) => {
  let orderRequest: unknown = null
  await page.route("**/api/favorites/order", async (route) => {
    orderRequest = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto("/react/")

  const yours = page.getByRole("region", { name: "Your apps" })
  await yours.getByRole("button", { name: "Reorder" }).click()
  await yours.getByRole("button", { name: "Move Pantry Planner earlier" }).click()

  await expect.poll(() => orderRequest).toEqual({ order: ["pantry-planner", "recipebot"] })
  await expect(yours.getByTestId("home-app-shortcut-pantry-planner")).toHaveText(/Pantry Planner/)
  await expect(yours.getByRole("button", { name: "Move Pantry Planner earlier" })).toBeDisabled()
})

test("restores the personal order when the server rejects it", async ({ page }) => {
  await page.route("**/api/favorites/order", (route) => route.fulfill({ status: 409, json: { error: "Your app order changed elsewhere" } }))
  await page.goto("/react/")

  const yours = page.getByRole("region", { name: "Your apps" })
  await yours.getByRole("button", { name: "Reorder" }).click()
  await yours.getByRole("button", { name: "Move Pantry Planner earlier" }).click()
  await expect(yours.getByRole("alert")).toContainText("Your app order changed elsewhere")
  await expect(yours.getByRole("button", { name: "Move RecipeBot earlier" })).toBeDisabled()
})

test("has one accessible shell structure on Home and app details", async ({ page }) => {
  await page.goto("/react/")
  await expectAccessibleShellStructure(page)

  await page.goto("/react/apps/recipebot")
  await expect(page.getByRole("heading", { name: "RecipeBot", level: 1 })).toBeVisible()
  await expectAccessibleShellStructure(page)
})

test("production review mode prevents saved-app requests", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let favoriteRequests = 0
  let orderingRequests = 0
  await page.route("**/api/apps/recipebot/favorite", async (route) => {
    favoriteRequests += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.route("**/api/favorites/order", async (route) => {
    orderingRequests += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.goto("/react/apps/recipebot")
  await expect(page.getByTestId("app-details-production-review")).toContainText("Read-only")
  await expect(page.getByTestId("app-details-production-review")).toContainText("Saving to Your apps, renaming, and change-approval updates are unavailable.")
  await expect(page.getByRole("button", { name: "Remove from Your apps" })).toBeDisabled()
  await page.goto("/react/")
  await expect(page.getByRole("region", { name: "Your apps" }).getByRole("button", { name: "Reorder" })).toBeDisabled()
  expect(favoriteRequests).toBe(0)
  expect(orderingRequests).toBe(0)
})

test("production review mode prevents change-lock writes", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let lockRequests = 0
  await page.route("**/api/apps/recipebot/lock", async (route) => {
    lockRequests += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.goto("/react/apps/recipebot")
  await expect(page.getByTestId("app-details-production-review")).toContainText("Read-only")
  await expect(page.getByTestId("app-details-production-review")).toContainText("Saving to Your apps, renaming, and change-approval updates are unavailable.")
  await expect(page.getByRole("button", { name: "Require an admin approval" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Rename" })).toBeDisabled()
  expect(lockRequests).toBe(0)
})
