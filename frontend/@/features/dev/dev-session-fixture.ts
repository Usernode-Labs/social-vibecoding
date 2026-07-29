import type { DevSessionResponse } from "@/lib/dev-chat-api"

/** A reviewable route fixture; never selected by a production build. */
export const devSessionFixture: DevSessionResponse = {
  session: {
    id: 9,
    app_slug: "recipebot",
    app_name: "RecipeBot",
    branch_name: "feature/pantry-filter",
    session_title: "Improve pantry search",
    pr_title: null,
    status: "active",
    created_at: "2026-07-28T12:00:00.000Z",
  },
  messages: [
    { id: 1, role: "system", content: "Session started · RecipeBot", model: null, token_count: null, cost_cents: null, metadata: null, created_at: "2026-07-28T12:00:00.000Z" },
    { id: 2, role: "user", content: "Add a pantry filter and make the empty state clearer.", model: null, token_count: null, cost_cents: null, metadata: null, created_at: "2026-07-28T12:01:00.000Z" },
    { id: 3, role: "assistant", content: "I’ll inspect the existing search flow first, then propose the smallest safe change.", model: "claude-opus-5", token_count: 42, cost_cents: 0, metadata: null, created_at: "2026-07-28T12:01:03.000Z" },
    { id: 4, role: "assistant", content: "The search already supports a query. I’ll add a pantry filter as a separate input so a user can clear either constraint without losing the other.", model: "claude-opus-5", token_count: 128, cost_cents: 0, metadata: null, created_at: "2026-07-28T12:01:12.000Z" },
  ],
}
