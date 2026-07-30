import type { Meta, StoryObj } from "@storybook/react-vite"
import { MergeRunList } from "@/features/admin/merge-debug"

const meta = { title: "Features/Admin/Merge debug", component: MergeRunList, parameters: { layout: "padded" } } satisfies Meta<typeof MergeRunList>
export default meta
type Story = StoryObj<typeof meta>
export const MixedOutcomes: Story = { args: { runs: [{ id: 1, app_name: "RecipeBot", pr_number: 48, pr_title: "Improve search", kind: "merge", status: "merged", step_count: 8, started_at: "2026-07-27T12:00:00Z", ended_at: "2026-07-27T12:01:32Z" }, { id: 2, app_name: "Appraise", pr_number: 19, pr_title: "Resolve branch drift", kind: "conflict_resolution", status: "conflict_failed", step_count: 5, started_at: "2026-07-27T10:00:00Z", ended_at: "2026-07-27T10:03:00Z" }] } }
export const Empty: Story = { args: { runs: [] } }
