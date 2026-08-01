import type { Meta, StoryObj } from "@storybook/react-vite"

import { ChallengeFeed } from "@/features/community/challenges"

const now = new Date("2026-07-28T12:00:00.000Z")

const snapshot = {
  season: { season_id: 8, name: "Summer build", is_active: true },
  entries: [],
  challengeProgress: [
    { challenge_id: 1, state: "in_progress" as const, current: 1.5, target: 3 },
    { challenge_id: 2, state: "pending" as const, pending_points: 100 },
    { challenge_id: 3, state: "earned" as const, current: 2, target: 2, earned_points: 150 },
    { challenge_id: 4, state: "in_progress" as const, current: 87 },
    { challenge_id: 6, state: "none" as const },
  ],
  challenges: [
    { id: 1, goal: "Publish a useful tool", task: "Invite feedback from three people.", category: "Build", reward: "250 points", featured: true, featured_order: 1, metric: { kind: "count", target: 3, label: "reviews" } },
    { id: 2, goal: "Share season feedback", task: "Complete the participant survey.", reward: "100 points", schedule_end: "2026-07-28T18:00:00.000Z", metric: { kind: "binary" } },
    { id: 3, goal: "Help test a new app", task: "Use an app and report one actionable issue.", category: "Community", reward: "150 points", schedule_end: "2026-08-01T12:00:00.000Z", metric: { kind: "count", target: 2, label: "reports" } },
    { id: 4, goal: "Keep your node online", task: "Background node reliability work.", category: "Node", reward: "Up to 500 points", schedule_end: "2026-08-20T12:00:00.000Z", metric: { kind: "percentage" } },
    { id: 5, goal: "Historical challenge", task: "A missed binary challenge remains legible.", reward: "75 points", state: "missed" },
    { id: 6, goal: "Experimental contribution", task: "Unknown metrics stay state-only until the service gives a bounded contract.", reward: "TBD", metric: { kind: "unknown" } },
  ],
}

const meta = {
  title: "Features/Community/Challenge feed",
  component: ChallengeFeed,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>],
} satisfies Meta<typeof ChallengeFeed>

export default meta
type Story = StoryObj<typeof meta>

export const FairRewardsContractMatrix: Story = { args: { snapshot, now } }

export const FairRewardsContractMatrixDark: Story = {
  ...FairRewardsContractMatrix,
  globals: { theme: "dark" },
}
