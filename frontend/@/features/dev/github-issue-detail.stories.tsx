import type { Meta, StoryObj } from "@storybook/react-vite"

import { GitHubIssueDetailContent } from "@/features/dev/github-issue-detail"
import { SidebarProvider } from "@/components/ui/sidebar"

const app = { id: "recipebot", slug: "recipebot", name: "RecipeBot", status: "running", active_users: 24, is_favorited: true, is_collaborator: true, your_apps_hidden: false, favorite_order: 0, open_prs: 1, active_sessions: 1, open_issues: 2 }
const issue = { number: 84, title: "Make pantry filters easier to find", created_by_username: "mira", body: "The pantry controls are difficult to discover on a small screen.\n\nPlease keep the existing search behavior.", bounty_count: 2, chatCount: 5, headless: { status: "ready" }, in_progress: { count: 1 }, htmlUrl: "https://github.com/Usernode-Labs/social-vibecoding/issues/84" }
const comments = [{ author: "mira", body: "The filters need to work with the existing search terms.", createdAt: "2026-07-28T08:00:00.000Z" }, { author: "sam", body: "I can take the first pass.", createdAt: "2026-07-28T09:00:00.000Z" }]
const closeProposal = { id: 910, kind: "close_issue", title: "Close issue #84", status: "open", up_count: 1, down_count: 0, created_at: "2026-07-28T10:00:00.000Z", payload: { issueNumber: 84, reason: "Resolved elsewhere." } }
const meta = { title: "Features/Dev/GitHub issue detail", component: GitHubIssueDetailContent, parameters: { layout: "fullscreen" }, decorators: [(Story) => <SidebarProvider><Story /></SidebarProvider>] } satisfies Meta<typeof GitHubIssueDetailContent>

export default meta
type Story = StoryObj<typeof meta>
export const WithDiscussion: Story = { args: { app, comments, issue, slug: "recipebot" } }
export const AlreadyPledged: Story = { args: { app, comments, issue: { ...issue, my_bounty: true, bounty_count: 3 }, slug: "recipebot" } }
export const ProposalGenerating: Story = { args: { app, comments, issue: { ...issue, headless: { status: "generating", sessionId: 701 } }, slug: "recipebot" } }
export const ProposalReadyToClone: Story = { args: { app, comments, issue: { ...issue, headless: { status: "ready", sessionId: 701, outcome: "spec" } }, slug: "recipebot" } }
export const LoadingComments: Story = { args: { app, comments: null, issue, slug: "recipebot" } }
export const TruncatedDiscussion: Story = { args: { app, comments, issue, slug: "recipebot", truncated: true } }
export const CloseProposalAvailable: Story = { args: { app, closeProposal: null, comments, currentUsername: "mira", issue, onCloseProposal: async () => undefined, onCloseProposalOpenChange: () => undefined, slug: "recipebot" } }
export const CloseProposalOpen: Story = { args: { app, closeProposal: null, closeProposalOpen: true, comments, currentUsername: "mira", issue, onCloseProposal: async () => undefined, onCloseProposalOpenChange: () => undefined, slug: "recipebot" } }
export const CloseProposalCreated: Story = { args: { app, closeProposal, closeProposalNotice: "Collaborators can now review and vote on this proposal.", comments, currentUsername: "mira", issue, slug: "recipebot" } }
export const CloseProposalError: Story = { args: { app, closeProposal: null, closeProposalError: "Couldn't confirm this issue is open right now. Try again in a moment.", comments, currentUsername: "mira", issue, onCloseProposal: async () => undefined, onCloseProposalOpenChange: () => undefined, slug: "recipebot" } }
export const AdminClaimRecovery: Story = { args: { app, canAdminWrite: true, comments, currentUsername: "mira", issue: { ...issue, in_progress: { count: 0, mine: false, claims: [{ userId: 8, username: "sam", mine: false, claimedAt: "2026-07-21T10:00:00.000Z" }] } }, onClearClaim: async () => undefined, slug: "recipebot" } }
