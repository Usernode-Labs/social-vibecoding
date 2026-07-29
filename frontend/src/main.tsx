import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router-dom"

import "./index.css"
import { PlatformShell } from "@/components/platform-shell"
import { RouteFallback } from "@/components/route-fallback"
import { NotFound } from "@/features/platform/not-found"
import { AppsHome } from "@/features/apps/apps-home"
import { registerReactServiceWorker } from "./react-service-worker"

const Login = lazy(async () => import("@/features/auth/login").then(({ Login: Component }) => ({ default: Component })))
const Register = lazy(async () => import("@/features/auth/register").then(({ Register: Component }) => ({ default: Component })))
const AppDetails = lazy(async () => import("@/features/apps/app-details").then(({ AppDetails: Component }) => ({ default: Component })))
const AppMembers = lazy(async () => import("@/features/apps/app-members").then(({ AppMembers: Component }) => ({ default: Component })))
const CreateApp = lazy(async () => import("@/features/apps/create-app").then(({ CreateApp: Component }) => ({ default: Component })))
const AppRecovery = lazy(async () => import("@/features/apps/app-recovery").then(({ AppRecovery: Component }) => ({ default: Component })))
const HostedApp = lazy(async () => import("@/features/apps/hosted-app").then(({ HostedApp: Component }) => ({ default: Component })))
const Leaderboard = lazy(async () => import("@/features/community/leaderboard").then(({ Leaderboard: Component }) => ({ default: Component })))
const LeaderboardHistory = lazy(async () => import("@/features/community/leaderboard").then(({ LeaderboardHistory: Component }) => ({ default: Component })))
const LeaderboardUserProfile = lazy(async () => import("@/features/community/leaderboard").then(({ LeaderboardUserProfile: Component }) => ({ default: Component })))
const Challenges = lazy(async () => import("@/features/community/challenges").then(({ Challenges: Component }) => ({ default: Component })))
const ChallengeDetail = lazy(async () => import("@/features/community/challenge-detail").then(({ ChallengeDetail: Component }) => ({ default: Component })))
const Work = lazy(async () => import("@/features/work/work").then(({ Work: Component }) => ({ default: Component })))
const Account = lazy(async () => import("@/features/account/account").then(({ Account: Component }) => ({ default: Component })))
const Settings = lazy(async () => import("@/features/account/settings").then(({ Settings: Component }) => ({ default: Component })))
const Feedback = lazy(async () => import("@/features/feedback/feedback").then(({ Feedback: Component }) => ({ default: Component })))
const Profile = lazy(async () => import("@/features/account/profile").then(({ Profile: Component }) => ({ default: Component })))
const Notifications = lazy(async () => import("@/features/notifications/notifications").then(({ Notifications: Component }) => ({ default: Component })))
const NodeStatusPage = lazy(async () => import("@/features/platform/node-status").then(({ NodeStatusPage: Component }) => ({ default: Component })))
const StatusPage = lazy(async () => import("@/features/platform/status").then(({ StatusPage: Component }) => ({ default: Component })))
const AppDev = lazy(async () => import("@/features/apps/app-dev").then(({ AppDev: Component }) => ({ default: Component })))
const DevSession = lazy(async () => import("@/features/dev/dev-session").then(({ DevSession: Component }) => ({ default: Component })))
const SharedSessionDetail = lazy(async () => import("@/features/dev/shared-session").then(({ SharedSessionDetail: Component }) => ({ default: Component })))
const GroupDiscussion = lazy(async () => import("@/features/dev/group-discussion").then(({ GroupDiscussion: Component }) => ({ default: Component })))
const StagingPreview = lazy(async () => import("@/features/dev/staging-preview").then(({ StagingPreview: Component }) => ({ default: Component })))
const DevGovernanceDetail = lazy(async () => import("@/features/dev/dev-governance-detail").then(({ DevGovernanceDetail: Component }) => ({ default: Component })))
const DevProposalDetail = lazy(async () => import("@/features/dev/dev-proposal-detail").then(({ DevProposalDetail: Component }) => ({ default: Component })))
const GitHubIssueDetail = lazy(async () => import("@/features/dev/github-issue-detail").then(({ GitHubIssueDetail: Component }) => ({ default: Component })))
const SessionSpecViewer = lazy(async () => import("@/features/dev/session-spec-viewer").then(({ SessionSpecViewer: Component }) => ({ default: Component })))
const AdminOverviewPage = lazy(async () => import("@/features/admin/admin-overview").then(({ AdminOverviewPage: Component }) => ({ default: Component })))
const AdminUsersPage = lazy(async () => import("@/features/admin/admin-users").then(({ AdminUsersPage: Component }) => ({ default: Component })))
const ActivationCodesPage = lazy(async () => import("@/features/admin/activation-codes").then(({ ActivationCodesPage: Component }) => ({ default: Component })))
const SpendLimitsPage = lazy(async () => import("@/features/admin/spend-limits").then(({ SpendLimitsPage: Component }) => ({ default: Component })))
const AdminFeaturesPage = lazy(async () => import("@/features/admin/admin-features").then(({ AdminFeaturesPage: Component }) => ({ default: Component })))
const MergeDebugPage = lazy(async () => import("@/features/admin/merge-debug").then(({ MergeDebugPage: Component }) => ({ default: Component })))
const GalleryPage = lazy(async () => import("@/features/admin/gallery").then(({ GalleryPage: Component }) => ({ default: Component })))

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename="/react">
      <PlatformShell>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route element={<Login />} path="/login" />
            <Route element={<Register />} path="/register" />
            <Route element={<AppsHome />} path="/" />
            <Route element={<CreateApp />} path="/create" />
            <Route element={<AppDetails />} path="/apps/:slug" />
            <Route element={<AppMembers />} path="/apps/:slug/members" />
            <Route element={<AppRecovery />} path="/apps/:slug/recovery" />
            <Route element={<HostedApp />} path="/apps/:slug/open" />
            <Route element={<Leaderboard />} path="/community/leaderboard" />
            <Route element={<LeaderboardHistory />} path="/community/leaderboard/history" />
            <Route element={<LeaderboardUserProfile />} path="/community/leaderboard/users/:username" />
            <Route element={<Challenges />} path="/community/challenges" />
            <Route element={<ChallengeDetail />} path="/community/challenges/:challengeId" />
            <Route element={<Work />} path="/work" />
            <Route element={<Account />} path="/account" />
            <Route element={<Profile />} path="/account/profile" />
            <Route element={<Settings />} path="/settings" />
            <Route element={<Feedback />} path="/feedback" />
            <Route element={<Notifications />} path="/notifications" />
            <Route element={<NodeStatusPage />} path="/node-status" />
            <Route element={<StatusPage />} path="/status" />
            <Route element={<AppDev />} path="/apps/:slug/dev" />
            <Route element={<GroupDiscussion />} path="/apps/:slug/dev/chat" />
            <Route element={<DevSession />} path="/apps/:slug/dev/sessions/:sessionId" />
            <Route element={<SessionSpecViewer />} path="/apps/:slug/dev/sessions/:sessionId/spec" />
            <Route element={<SharedSessionDetail />} path="/apps/:slug/dev/shared/:sessionId" />
            <Route element={<StagingPreview />} path="/apps/:slug/dev/sessions/:sessionId/preview" />
            <Route element={<DevGovernanceDetail />} path="/apps/:slug/dev/governance/:governanceId" />
            <Route element={<DevProposalDetail />} path="/apps/:slug/dev/proposals/:proposalId" />
            <Route element={<GitHubIssueDetail />} path="/apps/:slug/dev/issues/:issueNumber" />
            <Route element={<AdminOverviewPage />} path="/admin" />
            <Route element={<AdminUsersPage />} path="/admin/users" />
            <Route element={<ActivationCodesPage />} path="/admin/codes" />
            <Route element={<SpendLimitsPage />} path="/admin/limits" />
            <Route element={<AdminFeaturesPage />} path="/admin/features" />
            <Route element={<MergeDebugPage />} path="/admin/debug" />
            <Route element={<GalleryPage />} path="/admin/gallery" />
            <Route element={<NotFound />} path="*" />
          </Routes>
        </Suspense>
      </PlatformShell>
    </BrowserRouter>
  </StrictMode>,
)

registerReactServiceWorker()
