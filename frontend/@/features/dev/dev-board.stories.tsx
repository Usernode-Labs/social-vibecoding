import type { Meta, StoryObj } from "@storybook/react-vite"
import { DevBoard } from "@/features/dev/dev-board"

const snapshot = {
  issues: [
    { number: 82, title: "Make pantry search handle substitutions", created_by_username: "sam", priority: { top: "High" }, category: { top: "Search" }, assignee: { top: "Ava" }, in_progress: null },
    { number: 83, title: "Stream an app build from the session", created_by_username: "jules", priority: { top: "Medium" }, category: { top: "Developer experience" }, in_progress: { count: 1 } },
  ],
  proposals: [{ id: 17, pr_number: 49, pr_title: "Add ingredient substitutes", status: "promoted", username: "maya", yes_count: 2, no_count: 0, votes_required: 3, chat_count: 4, created_at: "2026-07-28T12:00:00.000Z", linked_issues: [82], assignee: { top: "Ava" }, my_vote: null }],
  governance: [{ id: 8, title: "Rename RecipeBot", kind: "rename", status: "open", up_count: 1, down_count: 0, votes_required: 3, chat_count: 1, created_at: "2026-07-28T12:00:00.000Z", my_vote: null }],
  merged: [{ id: 12, pr_number: 42, pr_title: "Improve saved recipes", username: "alex", created_at: "2026-07-27T12:00:00.000Z", row_type: "pr" }],
  sessions: [{ id: 31, branch_name: "dev/summer-menu", pr_title: null, session_title: "Build a summer menu", status: "active", warm: true, created_at: "2026-07-28T10:00:00.000Z" }],
  sharedSessions: [{ id: 32, branch_name: "dev/quick-meals", pr_title: null, session_title: "Quick meals", status: "paused", warm: false, created_at: "2026-07-28T09:00:00.000Z", username: "sofia", shared_at: "2026-07-28T09:30:00.000Z" }],
  order: { issues: [{ type: "issue" as const, ref: 82 }], review: [{ type: "proposal" as const, ref: 17 }] },
  pmOrder: { ava: [{ type: "proposal" as const, ref: 17 }, { type: "issue" as const, ref: 82 }] },
  mergedTotal: 1,
  mergedHasMore: false,
}

const meta = {
  title: "Features/Dev/Board",
  component: DevBoard,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-7xl bg-background p-4"><Story /></div>],
} satisfies Meta<typeof DevBoard>

export default meta
type Story = StoryObj<typeof meta>

const actions = { onPersistOrder: async () => undefined, onPersistPmMove: async () => undefined }

export const LifecycleWithOrdering: Story = { args: { slug: "recipebot", snapshot, canReorder: true, mode: "kanban", ...actions } }
export const LinearWorkFeed: Story = { args: { slug: "recipebot", snapshot, canReorder: false, mode: "list", ...actions } }
export const TasksByPerson: Story = { args: { slug: "recipebot", snapshot, canReorder: true, mode: "pm", ...actions } }
export const TasksByPersonReadOnly: Story = { args: { slug: "recipebot", snapshot, canReorder: false, mode: "pm", ...actions } }
export const ReadOnly: Story = { args: { slug: "recipebot", snapshot, canReorder: false, mode: "kanban", ...actions } }
