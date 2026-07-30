import type { Meta, StoryObj } from "@storybook/react-vite"
import { SpecDocument } from "@/features/dev/session-spec-viewer"
const meta = { title: "Blocks/Dev/Session spec", component: SpecDocument, parameters: { layout: "padded" } } satisfies Meta<typeof SpecDocument>
export default meta
type Story = StoryObj<typeof meta>
export const SplitSections: Story = { args: { content: "# Pantry improvements\n\nKeep weekly cooking simple.\n\n## User-facing changes\n\n- Filter recipes by pantry items.\n\n## Technical implementation\n\n- Index ingredients by normalized name.", versions: [{ version: 2, built_at: "2026-07-28T12:00:00Z", pr_number: 48 }, { version: 1, built_at: "2026-07-27T12:00:00Z" }] } }
export const Empty: Story = { args: { content: "", versions: [] } }
