import { Bot, MessageCircle, Sparkles, Timer } from "lucide-react"
import { ActionLink } from "@/components/action-link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { PlatformIcon } from "@/components/platform-icon"
import type { GitHubIssue } from "@/lib/github-issues-api"
import { appDevGitHubIssuePath } from "@/lib/routes"

type GitHubIssuesProps = {
  issues: GitHubIssue[] | null
  slug: string
}

function count(value: number | string | null | undefined) {
  return Number(value || 0)
}

function headlessLabel(issue: GitHubIssue) {
  if (issue.headless?.status === "generating") return "Proposal generating"
  if (issue.headless?.status === "ready") return "Proposal ready"
  return null
}

function IssueStatus({ issue }: { issue: GitHubIssue }) {
  const headless = headlessLabel(issue)
  const active = count(issue.in_progress?.count) || issue.in_progress?.claims?.length
  return <div className="flex flex-wrap gap-2">
    {headless ? <Badge variant="secondary"><PlatformIcon data-icon="inline-start" icon={issue.headless?.status === "generating" ? Timer : Sparkles} size="xs" />{headless}</Badge> : null}
    {active ? <Badge variant="outline">In progress{active > 1 ? ` · ${active}` : ""}</Badge> : null}
    {count(issue.bounty_count) ? <Badge variant="outline">{count(issue.bounty_count)} kudos pledged</Badge> : null}
    {count(issue.chatCount) ? <Badge variant="outline"><PlatformIcon data-icon="inline-start" icon={MessageCircle} size="xs" />{count(issue.chatCount)}</Badge> : null}
  </div>
}

function IssueCard({ issue, slug }: { issue: GitHubIssue; slug: string }) {
  return <Card>
    <CardHeader className="gap-2">
      <CardTitle className="flex min-w-0 flex-wrap items-start gap-2 text-base sm:text-sm"><span className="min-w-0 text-balance">{issue.title}</span></CardTitle>
      <CardDescription>GitHub issue #{issue.number}{issue.created_by_username ? ` · opened by ${issue.created_by_username}` : ""}</CardDescription>
    </CardHeader>
    <CardContent><IssueStatus issue={issue} /></CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      <ActionLink aria-label={`View ${issue.title}`} size="sm" to={appDevGitHubIssuePath(slug, issue.number)} variant="outline">View details</ActionLink>
    </CardFooter>
  </Card>
}

export function GitHubIssues({ issues, slug }: GitHubIssuesProps) {
  if (issues === null) return <div className="flex flex-col gap-3"><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></div>
  return <section className="flex flex-col gap-3" aria-labelledby="github-issues-heading">
    <header className="flex flex-col gap-1"><h4 className="text-base font-medium" id="github-issues-heading">Open GitHub issues</h4><p className="text-base text-muted-foreground sm:text-sm">Open a detail to discuss, claim, rename, or propose closing an issue.</p></header>
    {issues.length ? issues.map((issue) => <IssueCard issue={issue} key={issue.number} slug={slug} />) : <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Bot} /></EmptyMedia><EmptyTitle>No open GitHub issues</EmptyTitle><EmptyDescription>The repository has no visible open issues for this app.</EmptyDescription></EmptyHeader></Empty>}
  </section>
}
