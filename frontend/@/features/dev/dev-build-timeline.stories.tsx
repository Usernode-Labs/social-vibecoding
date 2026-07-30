import type { Meta, StoryObj } from "@storybook/react-vite"
import { DevBuildTimeline } from "@/features/dev/dev-build-timeline"
const meta = { title: "Blocks/Dev/Build timeline", component: DevBuildTimeline, parameters: { layout: "padded" } } satisfies Meta<typeof DevBuildTimeline>
export default meta
type Story = StoryObj<typeof meta>
export const ActiveAndPersisted: Story = { args: { estimate: "About 2 minutes remaining", liveLines: ["Running checks…", "Preparing preview…"], messages: [{ id: 3, role: "system", content: "Claude Code finished", model: null, token_count: null, cost_cents: null, created_at: "2026-07-28T12:00:00Z", metadata: { progressLog: ["Fetching main…", "Merging origin/main…"], ccOutput: "Implemented pantry filters.", ccLog: "warning: cache missed" } }] } }
