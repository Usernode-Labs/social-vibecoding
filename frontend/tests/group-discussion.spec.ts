import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const discussion = [
  { id: 1, user_id: 5, username: "mira", content: "Could dietary filters be easier to find?", msg_type: "message", metadata: null, created_at: "2026-07-28T09:00:00.000Z", edited_at: null, reactions: [{ emoji: "👍", count: 2, users: ["mira", "sam"] }] },
  { id: 2, user_id: 8, username: "sam", content: "I’ll keep the pantry flow intact.", msg_type: "message", metadata: { quote: { source: "message", author: "mira", snippet: "Could dietary filters be easier to find?" }, attachments: [{ id: "attachment-1", kind: "markdown", filename: "filter-notes.md", sizeBytes: 1200 }] }, created_at: "2026-07-28T09:02:00.000Z", edited_at: "2026-07-28T09:02:30.000Z", reactions: [] },
  { id: 3, user_id: null, username: null, content: "A proposal was promoted for review.", msg_type: "vote", metadata: null, created_at: "2026-07-28T09:03:00.000Z", reactions: [] },
]

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 5, username: "mira" } } }))
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: { id: "recipebot", slug: "recipebot", name: "RecipeBot", status: "running", active_users: 2, is_favorited: false, is_collaborator: true, your_apps_hidden: false, favorite_order: null, open_prs: 0, active_sessions: 0, open_issues: 0, can_collaborate: true } } }))
  await page.route("**/api/apps/recipebot/messages**", (route) => route.fulfill({ json: { messages: discussion } }))
})

async function installGroupChatSocket(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    type Handler = ((event: Event) => void) | null
    class GroupChatSocket {
      static instances: GroupChatSocket[] = []
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      readyState = 0
      onopen: Handler = null
      onclose: Handler = null
      onerror: Handler = null
      onmessage: ((event: MessageEvent) => void) | null = null
      sent: string[] = []
      typingSent: string[] = []
      readonly url: string
      constructor(url: string) {
        this.url = url
        GroupChatSocket.instances.push(this)
        window.setTimeout(() => { this.readyState = 1; this.onopen?.(new Event("open")) }, 0)
      }
      close() { this.readyState = 3; this.onclose?.(new Event("close")) }
      send(payload: string) {
        const parsed = JSON.parse(payload) as { type?: string }
        if (parsed.type === "typing") this.typingSent.push(payload)
        else this.sent.push(payload)
      }
      emit(payload: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) })) }
    }
    class WebSocketSpy {
      static CONNECTING = NativeWebSocket.CONNECTING
      static OPEN = NativeWebSocket.OPEN
      static CLOSING = NativeWebSocket.CLOSING
      static CLOSED = NativeWebSocket.CLOSED
      constructor(url: string | URL, protocols?: string | string[]) {
        if (String(url).includes("/ws/chat/")) return new GroupChatSocket(String(url))
        return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: WebSocketSpy })
    Object.assign(window, { __groupChatSockets: GroupChatSocket.instances })
  })
}

test("renders the complete view-authorized general discussion without a legacy handoff", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev/chat")
  const route = page.getByTestId("group-discussion")
  const chrome = route.locator('[data-slot="top-bar"]')
  await expect(route.getByRole("heading", { name: /RecipeBot.*Discussion/, level: 1 })).toBeVisible()
  await expect(route.locator("h1")).toHaveCount(1)
  await expect(chrome.getByRole("button", { name: "Back" })).toBeVisible()
  await expect(chrome.getByRole("button", { name: "Close RecipeBot" })).toHaveCount(0)
  expect(await route.getAttribute("class")).not.toMatch(/\b(?:mx-auto|max-w-)/)
  const chromeBox = await chrome.boundingBox()
  const transcriptBox = await page.getByLabel("App discussion messages").boundingBox()
  expect(chromeBox).not.toBeNull()
  expect(transcriptBox).not.toBeNull()
  expect(transcriptBox!.y).toBeGreaterThanOrEqual(chromeBox!.y + chromeBox!.height)
  await expect(route).toContainText("Could dietary filters be easier to find?")
  await expect(route.locator("blockquote").filter({ hasText: "↩ mira" })).toHaveCSS(
    "font-size",
    (page.viewportSize()?.width || 0) < 640 ? "14px" : "12px",
  )
  await expect(page.getByLabel("App discussion messages")).toContainText("A proposal was promoted for review.")
  const messageAvatar = route.locator('[data-slot="message-avatar"]').first()
  await expect(messageAvatar).toHaveCSS("width", "32px")
  await expect(messageAvatar).toHaveCSS("height", "32px")
  await expect(messageAvatar.locator(':scope > [data-slot="platform-icon"]')).toHaveCSS("width", "16px")
  await expect(messageAvatar.locator(':scope > [data-slot="platform-icon"]')).toHaveCSS("height", "16px")
  await expect(page.getByRole("link", { name: "Open the full discussion in legacy Dev" })).toHaveCount(0)
  const attachment = page.getByRole("link", { name: "Open attachment filter-notes.md" })
  await expect(attachment).toHaveAttribute("data-slot", "attachment-trigger")
  await expect(attachment).toHaveAttribute("href", "/api/apps/recipebot/chat-attachments/attachment-1")
  await expect(attachment).toHaveAttribute("download", "filter-notes.md")
  await expect(attachment).not.toHaveAttribute("target")
  await expect(attachment).not.toHaveAttribute("rel")
  await chrome.getByRole("button", { name: "Back" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev$/)
})

test("renders and canonically clears a per-message unread notification", async ({ page }) => {
  let readBody: unknown = null
  await page.route("**/api/apps/recipebot/messages**", (route) => route.fulfill({
    json: { messages: [{ ...discussion[0], has_unread_notification: true }, ...discussion.slice(1)] },
  }))
  await page.route("**/api/notifications/read", async (route) => {
    readBody = route.request().postDataJSON()
    await route.fulfill({ json: { unread: 0, cleared: 1 } })
  })
  await page.goto("/react/apps/recipebot/dev/chat")

  await expect(page.getByText("Unread mention, reply, or reaction")).toBeAttached()
  await page.getByRole("button", { name: "Mark message notification as read" }).click()
  await expect.poll(() => readBody).toEqual({ chat_message_id: 1 })
  await expect(page.getByRole("button", { name: "Mark message notification as read" })).toHaveCount(0)
})

test("posts only a top-level text message through the established collaborator socket", async ({ page }) => {
  await installGroupChatSocket(page)
  await page.goto("/react/apps/recipebot/dev/chat")
  await expect(page.getByRole("form", { name: "Post a discussion message" })).toBeVisible()
  await page.getByRole("textbox", { name: "Discussion message" }).fill("The filters now have a clear home.")
  await page.getByRole("button", { name: "Post discussion message" }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __groupChatSockets: Array<{ sent: string[] }> }).__groupChatSockets[0]?.sent)).toEqual([JSON.stringify({ type: "chat", content: "The filters now have a clear home." })])
})

test("sends throttled general typing and presents remote general typing", async ({ page }) => {
  await installGroupChatSocket(page)
  await page.goto("/react/apps/recipebot/dev/chat")
  await page.getByRole("textbox", { name: "Discussion message" }).fill("Draft")

  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __groupChatSockets: Array<{ typingSent: string[] }> }
  ).__groupChatSockets[0]?.typingSent)).toEqual([
    JSON.stringify({ type: "typing" }),
  ])

  await page.evaluate(() => {
    const socket = (window as unknown as {
      __groupChatSockets: Array<{ emit: (payload: unknown) => void }>
    }).__groupChatSockets[0]
    socket?.emit({ type: "typing", userId: 8, username: "sam" })
  })
  const typingPresence = page.getByText("sam is typing…")
  await expect(typingPresence).toBeVisible()
  await expect(typingPresence).toHaveCSS("font-size", "12px")
  await expect(page.getByText("0/4 files · 5/8000", { exact: true })).toHaveCSS("font-size", "12px")
})

test("uploads and sends an attachments-only general message", async ({ page }) => {
  await installGroupChatSocket(page)
  const attachmentId = "a".repeat(32)
  let uploadedBody = ""
  await page.route("**/api/apps/recipebot/chat-attachments?*", async (route) => {
    uploadedBody = (await route.request().postDataBuffer())?.toString("utf8") || ""
    await route.fulfill({
      json: {
        id: attachmentId,
        kind: "markdown",
        filename: "filter-notes.md",
        contentType: "text/markdown",
        sizeBytes: 18,
        meta: null,
      },
    })
  })
  await page.goto("/react/apps/recipebot/dev/chat")

  await page.getByLabel("Choose discussion attachments").setInputFiles({
    name: "filter-notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("Keep filters visible"),
  })
  await expect(page.getByLabel("Pending discussion attachments")).toContainText("filter-notes.md")
  await expect(page.getByRole("button", { name: "Post discussion message" })).toBeEnabled()
  await page.getByRole("button", { name: "Post discussion message" }).click()

  expect(uploadedBody).toBe("Keep filters visible")
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __groupChatSockets: Array<{ sent: string[] }> }
  ).__groupChatSockets[0]?.sent)).toEqual([
    JSON.stringify({
      type: "chat",
      content: "",
      attachmentIds: [attachmentId],
    }),
  ])
  await expect(page.getByLabel("Pending discussion attachments")).toHaveCount(0)
})

test("stages, cancels, and sends a server-validated reply reference", async ({ page }) => {
  await installGroupChatSocket(page)
  await page.goto("/react/apps/recipebot/dev/chat")

  await page.getByRole("button", { name: "Reply to mira" }).click()
  const preview = page.getByTestId("discussion-reply-preview")
  await expect(preview).toContainText("Replying to @mira")
  await expect(preview.getByText("Could dietary filters be easier to find?", { exact: true })).toHaveCSS(
    "font-size",
    (page.viewportSize()?.width || 0) < 640 ? "14px" : "12px",
  )
  await page.getByRole("button", { name: "Cancel reply" }).click()
  await expect(preview).toHaveCount(0)

  await page.getByRole("button", { name: "Reply to mira" }).click()
  await page.getByRole("textbox", { name: "Discussion message" }).fill("Yes, I can make that clearer.")
  await page.getByRole("button", { name: "Post discussion message" }).click()

  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __groupChatSockets: Array<{ sent: string[] }> }
  ).__groupChatSockets[0]?.sent)).toEqual([
    JSON.stringify({
      type: "chat",
      content: "Yes, I can make that clearer.",
      quote: { source: "message", refMsgId: 1 },
    }),
  ])
  await expect(preview).toHaveCount(0)
})

test("only offers an author edit and sends the canonical edit envelope", async ({ page }) => {
  await installGroupChatSocket(page)
  await page.goto("/react/apps/recipebot/dev/chat")

  await expect(page.getByRole("button", { name: "Edit your message" })).toHaveCount(1)
  await page.getByRole("button", { name: "Edit your message" }).click()
  const editor = page.getByRole("form", { name: "Edit message by mira" })
  await expect(editor).toBeVisible()
  await editor.getByRole("textbox", { name: "Edited message" }).fill("Could dietary filters stay visible?")
  await editor.getByRole("button", { name: "Save changes" }).click()

  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __groupChatSockets: Array<{ sent: string[] }> }
  ).__groupChatSockets[0]?.sent)).toEqual([
    JSON.stringify({
      type: "edit",
      messageId: 1,
      content: "Could dietary filters stay visible?",
    }),
  ])
  await expect(editor).toHaveCount(0)
})

test("toggles a reaction through the established collaborator socket and re-reads the canonical aggregate", async ({ page }) => {
  await installGroupChatSocket(page)
  let reads = 0
  await page.route("**/api/apps/recipebot/messages**", (route) => {
    reads += 1
    return route.fulfill({ json: { messages: reads < 3 ? discussion : [{ ...discussion[0], reactions: [{ emoji: "👍", count: 3, users: ["mira", "sam", "ava"] }] }, ...discussion.slice(1)] } })
  })
  await page.goto("/react/apps/recipebot/dev/chat")
  await page.getByRole("button", { name: "Toggle 👍 reaction" }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __groupChatSockets: Array<{ sent: string[] }> }).__groupChatSockets[0]?.sent)).toEqual([JSON.stringify({ type: "react", messageId: 1, emoji: "👍" })])
  await page.evaluate(() => {
    const socket = (window as unknown as { __groupChatSockets: Array<{ emit: (payload: unknown) => void }> }).__groupChatSockets[0]
    socket?.emit({ type: "reaction", messageId: 1, reactions: [{ emoji: "👍", count: 3, users: ["mira", "sam", "ava"] }] })
  })
  await expect(page.getByLabel("Message reactions").first()).toContainText("👍 3")
  expect(reads).toBeGreaterThanOrEqual(3)
})

test("posts a proposal-scoped message with the canonical thread envelope", async ({ page }) => {
  await installGroupChatSocket(page)
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({
    json: {
      promoted: [{
        id: 41,
        pr_number: 83,
        pr_title: "Keep filters above the keyboard",
        status: "promoted",
        yes_count: 1,
        no_count: 0,
        votes_required: 2,
        created_at: "2026-07-29T09:00:00.000Z",
      }],
    },
  }))
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: [] } }))

  await page.goto("/react/apps/recipebot/dev/proposals/41")
  await expect(page.getByRole("form", { name: "Post a topic discussion message" })).toBeVisible()
  await page.getByRole("textbox", { name: "Discussion message" }).fill("This is scoped to proposal 41.")
  await page.getByRole("button", { name: "Post discussion message" }).click()

  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __groupChatSockets: Array<{ sent: string[] }> }
  ).__groupChatSockets[0]?.sent)).toEqual([
    JSON.stringify({
      type: "chat",
      content: "This is scoped to proposal 41.",
      thread: { type: "session", ref: 41 },
    }),
  ])
})

test("keeps uploaded attachment ids inside the scoped chat envelope", async ({ page }) => {
  await installGroupChatSocket(page)
  const attachmentId = "b".repeat(32)
  await page.route("**/api/apps/recipebot/chat-attachments?*", (route) => route.fulfill({
    json: {
      id: attachmentId,
      kind: "text",
      filename: "keyboard-note.txt",
      contentType: "text/plain",
      sizeBytes: 16,
      meta: null,
    },
  }))
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({
    json: {
      promoted: [{
        id: 41,
        pr_number: 83,
        pr_title: "Keep filters above the keyboard",
        status: "promoted",
        yes_count: 1,
        no_count: 0,
        votes_required: 2,
        created_at: "2026-07-29T09:00:00.000Z",
      }],
    },
  }))
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: [] } }))
  await page.goto("/react/apps/recipebot/dev/proposals/41")

  await page.getByLabel("Choose discussion attachments").setInputFiles({
    name: "keyboard-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Keyboard note"),
  })
  await page.getByRole("textbox", { name: "Discussion message" }).fill("The supporting note is attached.")
  await page.getByRole("button", { name: "Post discussion message" }).click()

  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __groupChatSockets: Array<{ sent: string[] }> }
  ).__groupChatSockets[0]?.sent)).toEqual([
    JSON.stringify({
      type: "chat",
      content: "The supporting note is attached.",
      thread: { type: "session", ref: 41 },
      attachmentIds: [attachmentId],
    }),
  ])
})

test("keeps typing indicators and sends isolated to the mounted topic", async ({ page }) => {
  await installGroupChatSocket(page)
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({
    json: {
      promoted: [{
        id: 41,
        pr_number: 83,
        pr_title: "Keep filters above the keyboard",
        status: "promoted",
        yes_count: 1,
        no_count: 0,
        votes_required: 2,
        created_at: "2026-07-29T09:00:00.000Z",
      }],
    },
  }))
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: [] } }))
  await page.goto("/react/apps/recipebot/dev/proposals/41")
  await expect(page.getByRole("form", { name: "Post a topic discussion message" })).toBeVisible()

  await page.evaluate(() => {
    const socket = (window as unknown as {
      __groupChatSockets: Array<{ emit: (payload: unknown) => void }>
    }).__groupChatSockets[0]
    socket?.emit({ type: "typing", userId: 9, username: "lee" })
    socket?.emit({ type: "typing", userId: 8, username: "sam", thread: { type: "session", ref: 99 } })
  })
  await expect(page.getByText(/lee is typing|sam is typing/)).toHaveCount(0)

  await page.evaluate(() => {
    const socket = (window as unknown as {
      __groupChatSockets: Array<{ emit: (payload: unknown) => void }>
    }).__groupChatSockets[0]
    socket?.emit({ type: "typing", userId: 8, username: "sam", thread: { type: "session", ref: 41 } })
  })
  await expect(page.getByText("sam is typing…")).toBeVisible()

  await page.getByRole("textbox", { name: "Discussion message" }).fill("Scoped draft")
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __groupChatSockets: Array<{ typingSent: string[] }> }
  ).__groupChatSockets[0]?.typingSent)).toEqual([
    JSON.stringify({ type: "typing", thread: { type: "session", ref: 41 } }),
  ])
})

test("keeps the canonical thread and quote references together for a scoped reply", async ({ page }) => {
  await installGroupChatSocket(page)
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({
    json: {
      promoted: [{
        id: 41,
        pr_number: 83,
        pr_title: "Keep filters above the keyboard",
        status: "promoted",
        yes_count: 1,
        no_count: 0,
        votes_required: 2,
        created_at: "2026-07-29T09:00:00.000Z",
      }],
    },
  }))
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: [] } }))

  await page.goto("/react/apps/recipebot/dev/proposals/41")
  await page.getByRole("button", { name: "Reply to mira" }).click()
  await page.getByRole("textbox", { name: "Discussion message" }).fill("That constraint belongs in this proposal.")
  await page.getByRole("button", { name: "Post discussion message" }).click()

  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __groupChatSockets: Array<{ sent: string[] }> }
  ).__groupChatSockets[0]?.sent)).toEqual([
    JSON.stringify({
      type: "chat",
      content: "That constraint belongs in this proposal.",
      thread: { type: "session", ref: 41 },
      quote: { source: "message", refMsgId: 1 },
    }),
  ])
})

test("edits an authored scoped message without changing the socket thread", async ({ page }) => {
  await installGroupChatSocket(page)
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({
    json: {
      promoted: [{
        id: 41,
        pr_number: 83,
        pr_title: "Keep filters above the keyboard",
        status: "promoted",
        yes_count: 1,
        no_count: 0,
        votes_required: 2,
        created_at: "2026-07-29T09:00:00.000Z",
      }],
    },
  }))
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: [] } }))

  await page.goto("/react/apps/recipebot/dev/proposals/41")
  await page.getByRole("button", { name: "Edit your message" }).click()
  const editor = page.getByRole("form", { name: "Edit message by mira" })
  await editor.getByRole("textbox", { name: "Edited message" }).fill("Keep filters visible above the keyboard.")
  await editor.getByRole("button", { name: "Save changes" }).click()

  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __groupChatSockets: Array<{ sent: string[] }> }
  ).__groupChatSockets[0]?.sent)).toEqual([
    JSON.stringify({
      type: "edit",
      messageId: 1,
      content: "Keep filters visible above the keyboard.",
    }),
  ])
})

test("keeps unrelated scoped socket broadcasts out of the mounted proposal discussion", async ({ page }) => {
  await installGroupChatSocket(page)
  let reads = 0
  await page.route("**/api/apps/recipebot/messages**", (route) => {
    reads += 1
    return route.fulfill({ json: { messages: discussion } })
  })
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({
    json: {
      promoted: [{
        id: 41,
        pr_number: 83,
        pr_title: "Keep filters above the keyboard",
        status: "promoted",
        yes_count: 1,
        no_count: 0,
        votes_required: 2,
        created_at: "2026-07-29T09:00:00.000Z",
      }],
    },
  }))
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: [] } }))

  await page.goto("/react/apps/recipebot/dev/proposals/41")
  const readsAfterMount = reads
  await page.evaluate(() => {
    const socket = (window as unknown as {
      __groupChatSockets: Array<{ emit: (payload: unknown) => void }>
    }).__groupChatSockets[0]
    socket?.emit({
      type: "chat",
      content: "Wrong topic",
      thread: { type: "session", ref: 99 },
    })
  })
  await page.waitForTimeout(100)
  expect(reads).toBe(readsAfterMount)

  await page.evaluate(() => {
    const socket = (window as unknown as {
      __groupChatSockets: Array<{ emit: (payload: unknown) => void }>
    }).__groupChatSockets[0]
    socket?.emit({
      type: "chat",
      content: "Right topic",
      thread: { type: "session", ref: 41 },
    })
  })
  await expect.poll(() => reads).toBeGreaterThan(readsAfterMount)
})

test("refetches canonical history when the chat socket broadcasts a top-level message", async ({ page }) => {
  await installGroupChatSocket(page)
  let reads = 0
  await page.route("**/api/apps/recipebot/messages**", (route) => {
    reads += 1
    return route.fulfill({ json: { messages: reads < 3 ? discussion : [...discussion, { id: 4, user_id: 9, username: "lee", content: "Canonical socket refresh", msg_type: "message", metadata: null, created_at: "2026-07-28T09:04:00.000Z", reactions: [] }] } })
  })
  await page.goto("/react/apps/recipebot/dev/chat")
  await expect(page.getByTestId("group-discussion")).toContainText("Could dietary filters be easier to find?")
  await page.evaluate(() => {
    const socket = (window as unknown as { __groupChatSockets: Array<{ emit: (payload: unknown) => void }> }).__groupChatSockets[0]
    socket?.emit({ type: "chat", id: 4, userId: 9, username: "lee", content: "Canonical socket refresh", msgType: "message", createdAt: "2026-07-28T09:04:00.000Z" })
  })
  await expect(page.getByTestId("group-discussion")).toContainText("Canonical socket refresh")
  expect(reads).toBeGreaterThanOrEqual(3)
})

test("renders an explicit empty state", async ({ page }) => {
  await page.route("**/api/apps/empty/messages**", (route) => route.fulfill({ json: { messages: [] } }))
  await page.route("**/api/apps/empty", (route) => route.fulfill({ json: { app: { id: "empty", slug: "empty", name: "Empty", status: "running", active_users: 0, is_favorited: false, is_collaborator: false, your_apps_hidden: false, favorite_order: null, open_prs: 0, active_sessions: 0, open_issues: 0, can_collaborate: false } } }))
  await page.goto("/react/apps/empty/dev/chat")
  await expect(page.getByText("No discussion yet")).toBeVisible()
})

test("keeps the discussion composer out of a view-only app", async ({ page }) => {
  await page.route("**/api/apps/view-only/messages**", (route) => route.fulfill({ json: { messages: discussion } }))
  await page.route("**/api/apps/view-only", (route) => route.fulfill({ json: { app: { id: "view-only", slug: "view-only", name: "View only", status: "running", active_users: 2, is_favorited: false, is_collaborator: false, your_apps_hidden: false, favorite_order: null, open_prs: 0, active_sessions: 0, open_issues: 0, can_collaborate: false } } }))
  await page.goto("/react/apps/view-only/dev/chat")
  await expect(page.getByRole("alert").filter({ hasText: "View-only discussion" })).toBeVisible()
  await expect(page.getByRole("form", { name: "Post a discussion message" })).toHaveCount(0)
})

test("renders a recoverable API error", async ({ page }) => {
  await page.route("**/api/apps/error/messages**", (route) => route.fulfill({ status: 403, json: { error: "Forbidden" } }))
  await page.route("**/api/apps/error", (route) => route.fulfill({ status: 403, json: { error: "Forbidden" } }))
  await page.goto("/react/apps/error/dev/chat")
  await expect(page.getByText("Discussion unavailable")).toBeVisible()
})

test("production review mode keeps collaborator discussion read-only", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  await page.goto("/react/apps/recipebot/dev/chat")
  await expect(page.getByRole("alert").filter({ hasText: "Read-only" })).toContainText("Posting and reactions are unavailable.")
  await expect(page.getByRole("form", { name: "Post a discussion message" })).toHaveCount(0)
  // The local review guard also rejects raw group-chat paths before Vite can
  // proxy them to production; the UI guard alone would be insufficient.
  expect((await page.request.get("/ws/chat/recipebot")).status()).toBe(404)
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev/chat")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
