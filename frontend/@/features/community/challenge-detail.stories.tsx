import type { Meta, StoryObj } from "@storybook/react-vite"

import { ChallengeDetailContent } from "@/features/community/challenge-detail"
import { SidebarProvider } from "@/components/ui/sidebar"

const challenge = {
  id: 12,
  goal: "Review three app proposals",
  task: "Give useful feedback on open proposals.",
  category: "Build",
  reward: "300 points",
  description: "Review proposals that help the community.",
  requirements: "Leave constructive feedback on three proposals.",
  reward_logic: "Points are awarded after review approval.",
  cta_label: "Review in legacy",
  cta_link: "/#challenges/12",
  metric: { kind: "count", target: 3, label: "reviews" },
}

const meta = {
  title: "Features/Community/Challenge detail",
  component: ChallengeDetailContent,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <SidebarProvider><Story /></SidebarProvider>],
} satisfies Meta<typeof ChallengeDetailContent>

export default meta
type Story = StoryObj<typeof meta>

export const NativeInProgress: Story = { args: { challenge, native: true, progress: { challenge_id: 12, state: "in_progress", current: 1.5, target: 3 }, season: "Summer build" } }
export const PublicOpen: Story = { args: { challenge, native: false, progress: { challenge_id: 12, state: "none" }, season: "Summer build" } }
export const Pending: Story = { args: { challenge, native: true, progress: { challenge_id: 12, state: "pending", pending_points: 300, description: "Submitted — awaiting review" }, season: "Summer build" } }
export const Completed: Story = { args: { challenge: { ...challenge, completed: true }, native: true, progress: { challenge_id: 12, state: "earned", earned_points: 300 }, season: "Summer build" } }
export const CompletedDark: Story = { ...Completed, globals: { theme: "dark" } }
export const Missed: Story = { args: { challenge, native: false, progress: { challenge_id: 12, state: "missed" }, season: "Summer build" } }
