import type { Meta, StoryObj } from "@storybook/react-vite"

import { DevConsolePanel, type DevConsoleEntry } from "@/components/dev-console-panel"

const entries: DevConsoleEntry[] = [
  {
    id: "1",
    level: "info",
    args: ["RecipeBot initialized"],
    timestamp: Date.parse("2026-07-28T12:00:00Z"),
    url: "https://recipebot.example.test/",
    source: "app.js",
    line: 42,
    column: 3,
  },
  {
    id: "2",
    level: "warn",
    args: ["Ingredient index is stale", "{\n  \"ageSeconds\": 92\n}"],
    timestamp: Date.parse("2026-07-28T12:00:02Z"),
    url: "https://recipebot.example.test/",
    source: "search.js",
    line: 18,
    column: 9,
  },
  {
    id: "3",
    level: "error",
    args: ["Recipe lookup failed", "Request failed (503)"],
    timestamp: Date.parse("2026-07-28T12:00:04Z"),
    url: "https://recipebot.example.test/",
    source: "recipes.js",
    line: 77,
    column: 12,
  },
]

const meta = {
  title: "Blocks/Shell/Developer console",
  component: DevConsolePanel,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="flex h-[32rem] flex-col"><Story /></div>],
  args: {
    entries,
    filter: "all",
    onClear: () => undefined,
    onFilterChange: () => undefined,
  },
} satisfies Meta<typeof DevConsolePanel>

export default meta
type Story = StoryObj<typeof meta>

export const MixedMessages: Story = {}
export const ErrorsOnly: Story = { args: { filter: "error" } }
export const Empty: Story = { args: { entries: [] } }
