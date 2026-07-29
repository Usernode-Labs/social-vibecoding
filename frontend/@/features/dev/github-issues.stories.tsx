import type { Meta, StoryObj } from "@storybook/react-vite"

import { GitHubIssues } from "@/features/dev/github-issues"

const issues = [{ number: 84, title: "Make pantry filters easier to find", created_by_username: "mira", bounty_count: 2, chatCount: 5, headless: { status: "ready", outcome: "spec" }, in_progress: { count: 1 } }, { number: 91, title: "Explain ingredient substitutions", created_by_username: "sam", bounty_count: 0, chatCount: 0, in_progress: { claims: [{ username: "sam" }, { username: "mira" }] } }]

const meta = { title: "Dev/GitHub issues", component: GitHubIssues, parameters: { layout: "fullscreen" } } satisfies Meta<typeof GitHubIssues>

export default meta
type Story = StoryObj<typeof meta>

export const WithActivity: Story = { args: { issues, slug: "recipebot" } }
export const Empty: Story = { args: { issues: [], slug: "recipebot" } }
export const Loading: Story = { args: { issues: null, slug: "recipebot" } }
