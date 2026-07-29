import { ArrowLeft, Award, Bot, CircleCheckBig, CircleX, ExternalLink, MessageCircle, Pencil, Plus, Save, Sparkles, Vote, X } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { PlatformIcon } from "@/components/platform-icon"
import { TopicAttributeControls } from "@/features/dev/topic-attribute-controls"
import { TopicDiscussionTranscript } from "@/features/dev/topic-discussion-transcript"
import { getCurrentUser } from "@/lib/auth-api"
import { createAppSession } from "@/lib/apps-api"
import { readBrowserPreference, writeBrowserPreference } from "@/lib/browser-preferences"
import { getDevModels, type DevModel } from "@/lib/dev-chat-api"
import { issueKickoffDraft, saveDevSessionDraft } from "@/lib/dev-session-draft"
import { createCloseIssueProposal, getOpenGovernanceIssues, type DevIssue } from "@/lib/dev-forum-api"
import { claimGitHubIssue, clearGitHubIssueAttribute, clearGitHubIssueClaim, clearMyGitHubIssueClaim, cloneHeadlessGitHubIssueSession, getGitHubIssueAttribute, getGitHubIssueComments, getGitHubIssues, giveGitHubIssueBounty, renameGitHubIssue, setGitHubIssueAttribute, startHeadlessGitHubIssueSession, type GitHubIssue, type GitHubIssueComment, type TopicAttributeField, type TopicAttributeOptions } from "@/lib/github-issues-api"
import { appDevGovernancePath, appDevPath, appDevSessionPath } from "@/lib/routes"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

const EMPTY_ATTRIBUTES: Partial<Record<TopicAttributeField, TopicAttributeOptions | null>> = {}
const EMPTY_MODELS: DevModel[] = []

function Comments({ comments, truncated }: { comments: GitHubIssueComment[] | null; truncated: boolean }) {
  if (comments === null) return <div className="flex flex-col gap-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
  if (!comments.length) return <p className="text-base text-muted-foreground sm:text-sm">No GitHub comments are available.</p>
  return <div className="flex flex-col divide-y divide-border rounded-md border">
    {comments.map((comment) => <article className="flex flex-col gap-2 p-4" key={`${comment.author || "unknown"}-${comment.createdAt || "undated"}-${comment.body || "empty"}`}><p className="text-base font-medium sm:text-sm">{comment.author || "Unknown contributor"}</p><p className="whitespace-pre-wrap text-base text-muted-foreground sm:text-sm">{comment.body || "No comment text."}</p></article>)}
    {truncated ? <p className="p-4 text-base text-muted-foreground sm:text-sm">Only the newest GitHub comments are shown here.</p> : null}
  </div>
}

type GitHubIssueDetailContentProps = {
  attributeError?: string | null
  attributes?: Partial<Record<TopicAttributeField, TopicAttributeOptions | null>>
  attributeUpdating?: TopicAttributeField | null
  bountyError?: string | null
  bountyNotice?: string | null
  bountyUpdating?: boolean
  canAdminWrite?: boolean
  claiming?: boolean
  claimClearingUserId?: number | string | null
  claimError?: string | null
  comments: GitHubIssueComment[] | null
  closeProposal?: DevIssue | null
  closeProposalError?: string | null
  closeProposalNotice?: string | null
  closeProposalOpen?: boolean
  closeProposalSubmitting?: boolean
  creatingSession?: boolean
  currentUsername?: string | null
  issue: GitHubIssue
  headlessCloning?: boolean
  headlessError?: string | null
  headlessNotice?: string | null
  headlessOpen?: boolean
  headlessStarting?: boolean
  modelError?: string | null
  models?: DevModel[]
  onBounty?: () => Promise<void>
  onClearClaim?: (userId: number | string) => Promise<void>
  onCloneHeadless?: () => Promise<void>
  onClaim?: (claim: boolean) => Promise<void>
  onCloseProposal?: (reason: string) => Promise<void>
  onCloseProposalOpenChange?: (open: boolean) => void
  onCreateSession?: () => Promise<void>
  onHeadlessOpenChange?: (open: boolean) => void
  onAttribute?: (field: TopicAttributeField, value: string | null) => Promise<boolean>
  onRename?: (title: string) => Promise<boolean>
  onSelectedModelChange?: (model: string | null) => void
  onStartHeadless?: () => Promise<void>
  renaming?: boolean
  renameError?: string | null
  sessionError?: string | null
  slug: string
  selectedModel?: string
  truncated?: boolean
  children?: ReactNode
}

export function GitHubIssueDetailContent({ attributeError, attributes = EMPTY_ATTRIBUTES, attributeUpdating = null, bountyError, bountyNotice, bountyUpdating = false, canAdminWrite = false, children, claiming = false, claimClearingUserId = null, claimError, closeProposal, closeProposalError, closeProposalNotice, closeProposalOpen = false, closeProposalSubmitting = false, comments, creatingSession = false, currentUsername, headlessCloning = false, headlessError, headlessNotice, headlessOpen = false, headlessStarting = false, issue, modelError, models = EMPTY_MODELS, onAttribute, onBounty, onClearClaim, onCloneHeadless, onClaim, onCloseProposal, onCloseProposalOpenChange, onCreateSession, onHeadlessOpenChange, onRename, onSelectedModelChange, onStartHeadless, renaming = false, renameError, selectedModel = "", sessionError, slug, truncated = false }: GitHubIssueDetailContentProps) {
  const back = appDevPath(slug)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(issue.title)
  const [closeReason, setCloseReason] = useState("")
  const canRename = Boolean(onRename) && currentUsername === issue.created_by_username && !isProductionReadOnlyReview
  const canClaim = Boolean(onClaim) && Boolean(currentUsername) && !isProductionReadOnlyReview
  const canSetAttributes = Boolean(onAttribute) && Boolean(currentUsername) && !isProductionReadOnlyReview
  const canBounty = Boolean(onBounty) && Boolean(currentUsername) && !issue.my_bounty && !isProductionReadOnlyReview
  const canProposeClose = closeProposal === null && Boolean(onCloseProposal) && Boolean(currentUsername) && !isProductionReadOnlyReview
  const canCreateSession = Boolean(onCreateSession) && Boolean(currentUsername) && !isProductionReadOnlyReview
  const claims = issue.in_progress?.claims || []
  const canClearClaims = canAdminWrite && Boolean(onClearClaim) && claims.length > 0 && !isProductionReadOnlyReview
  const headless = issue.headless
  const canStartHeadless = Boolean(onStartHeadless) && Boolean(currentUsername) && headless?.status !== "generating" && !(headless?.status === "ready" && headless.outcome !== "question") && !isProductionReadOnlyReview
  const canCloneHeadless = Boolean(onCloneHeadless) && Boolean(headless?.sessionId) && headless?.status === "ready" && !headless?.mySessionId && !isProductionReadOnlyReview
  const mine = Boolean(issue.in_progress?.mine)

  useEffect(() => { if (!editing) setTitle(issue.title) }, [editing, issue.title])

  const save = () => {
    const next = title.trim()
    if (next && next !== issue.title) void onRename?.(next).then((updated) => { if (updated) setEditing(false) })
    else setEditing(false)
  }

  const submitCloseProposal = () => {
    if (!canProposeClose || closeProposalSubmitting) return
    void onCloseProposal?.(closeReason)
  }

  return <div className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="github-issue-detail">
    <Button className="w-fit" render={<Link to={back} />} variant="ghost"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />App Dev</Button>
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {editing ? <div className="flex min-w-0 flex-1 flex-col gap-2"><Input aria-label="Issue title" disabled={renaming} maxLength={200} onChange={(event) => setTitle(event.target.value)} value={title} /><div className="flex flex-wrap gap-2"><Button disabled={renaming || !title.trim()} onClick={save} size="sm" type="button"><PlatformIcon data-icon="inline-start" icon={Save} />{renaming ? "Saving…" : "Save title"}</Button><Button disabled={renaming} onClick={() => { setTitle(issue.title); setEditing(false) }} size="sm" type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={X} />Cancel</Button></div></div> : <CardTitle className="text-balance text-2xl font-semibold tracking-tight"><h1>{issue.title}</h1></CardTitle>}
          {canRename && !editing ? <Button aria-label="Edit issue title" onClick={() => setEditing(true)} size="icon-sm" type="button" variant="ghost"><PlatformIcon icon={Pencil} /></Button> : null}
        </div>
        <CardDescription>GitHub issue #{issue.number}{issue.created_by_username ? ` · opened by ${issue.created_by_username}` : ""}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {renameError ? <Alert variant="destructive"><AlertTitle>Title was not updated</AlertTitle><AlertDescription>{renameError}</AlertDescription></Alert> : null}
        {claimError ? <Alert variant="destructive"><AlertTitle>In-progress mark was not updated</AlertTitle><AlertDescription>{claimError}</AlertDescription></Alert> : null}
        {attributeError ? <Alert variant="destructive"><AlertTitle>Community signal was not updated</AlertTitle><AlertDescription>{attributeError}</AlertDescription></Alert> : null}
        {bountyError ? <Alert variant="destructive"><AlertTitle>Kudos pledge was not recorded</AlertTitle><AlertDescription>{bountyError}</AlertDescription></Alert> : null}
        {bountyNotice ? <Alert><AlertTitle>Kudos pledged</AlertTitle><AlertDescription>{bountyNotice}</AlertDescription></Alert> : null}
        {closeProposalError && !closeProposalOpen ? <Alert variant="destructive"><AlertTitle>Close proposal was not created</AlertTitle><AlertDescription>{closeProposalError}</AlertDescription></Alert> : null}
        {closeProposalNotice ? <Alert><AlertTitle>Close proposal created</AlertTitle><AlertDescription>{closeProposalNotice}</AlertDescription></Alert> : null}
        {headlessError ? <Alert variant="destructive"><AlertTitle>Proposal generator was not started</AlertTitle><AlertDescription>{headlessError}</AlertDescription></Alert> : null}
        {headlessNotice ? <Alert><AlertTitle>Proposal generator started</AlertTitle><AlertDescription>{headlessNotice}</AlertDescription></Alert> : null}
        {sessionError ? <Alert variant="destructive"><AlertTitle>Dev session was not created</AlertTitle><AlertDescription>{sessionError}</AlertDescription></Alert> : null}
        {isProductionReadOnlyReview && currentUsername ? <Alert><AlertTitle>Production review mode</AlertTitle><AlertDescription>Issue details can be reviewed here, but editing, close proposals, priority, in-progress marks, and kudos pledges are disabled.</AlertDescription></Alert> : null}
        <div className="flex flex-wrap gap-2">
          {issue.headless?.status === "ready" ? <Badge variant="secondary"><PlatformIcon data-icon="inline-start" icon={Sparkles} size="xs" />Proposal ready</Badge> : null}
          {issue.headless?.status === "generating" ? <Badge variant="secondary">Proposal generating</Badge> : null}
          {issue.in_progress?.count || issue.in_progress?.claims?.length ? <Badge variant="outline">In progress</Badge> : null}
          {issue.priority?.top ? <Badge variant="outline">{issue.priority.top} priority</Badge> : null}
          {issue.bounty_count ? <Badge variant="outline">{Number(issue.bounty_count)} kudos pledged</Badge> : null}
          {issue.my_bounty ? <Badge variant="secondary">Your pledge</Badge> : null}
        </div>
        {canClearClaims ? <section aria-labelledby="github-issue-claims" className="flex flex-col gap-2"><h2 className="text-sm font-medium" id="github-issue-claims">In-progress claims</h2><div className="flex flex-wrap gap-2">{claims.map((claim) => {
          if (claim.userId === null || claim.userId === undefined) return null
          const clearing = String(claimClearingUserId) === String(claim.userId)
          const username = claim.username || "Unknown collaborator"
          return <Badge className="gap-1 pl-2.5 pr-1" key={String(claim.userId)} variant="outline"><span>{username}</span><Button aria-label={`Clear ${username}'s in-progress claim`} disabled={claimClearingUserId !== null} onClick={() => void onClearClaim?.(claim.userId!)} size="icon-xs" type="button" variant="ghost"><PlatformIcon icon={clearing ? CircleX : X} size="xs" /></Button></Badge>
        })}</div><p className="text-sm text-muted-foreground">Clearing a stale mark does not close the issue or stop an active Dev session.</p></section> : null}
        {canSetAttributes ? <TopicAttributeControls attributes={attributes} disabled={isProductionReadOnlyReview} onChange={(field, value) => onAttribute?.(field, value) || Promise.resolve(false)} pendingField={attributeUpdating} /> : null}
        <p className="whitespace-pre-wrap text-base text-pretty text-foreground sm:text-sm">{issue.body || "No issue description was provided."}</p>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {canClaim ? <Button disabled={claiming} onClick={() => void onClaim?.(!mine)} size="sm" type="button" variant={mine ? "outline" : "default"}><PlatformIcon data-icon="inline-start" icon={CircleCheckBig} />{claiming ? "Updating…" : mine ? "Clear my in-progress mark" : "Mark in progress"}</Button> : null}
        {canBounty ? <Button disabled={bountyUpdating} onClick={() => void onBounty?.()} size="sm" type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={Award} />{bountyUpdating ? "Pledging…" : "Give kudos"}</Button> : null}
        {canCreateSession ? <Button disabled={creatingSession} onClick={() => void onCreateSession?.()} size="sm" type="button"><PlatformIcon data-icon="inline-start" icon={Plus} />{creatingSession ? "Creating session…" : "Create proposal"}</Button> : null}
        {headless?.status === "generating" ? <Button disabled size="sm" type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={Bot} />Generating proposal…</Button> : null}
        {headless?.status === "ready" && headless.mySessionId ? <Button render={<Link to={appDevSessionPath(slug, headless.mySessionId)} />} size="sm" variant="outline"><PlatformIcon data-icon="inline-start" icon={Bot} />Go to my session</Button> : null}
        {canCloneHeadless ? <Button disabled={headlessCloning} onClick={() => void onCloneHeadless?.()} size="sm" type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={Bot} />{headlessCloning ? "Starting session…" : headless?.outcome === "spec" ? "Review spec & start session" : headless?.outcome === "question" ? "Answer question & start session" : "Review & start session"}</Button> : null}
        {canStartHeadless ? <AlertDialog open={headlessOpen} onOpenChange={onHeadlessOpenChange}><AlertDialogTrigger disabled={models.length === 0 || headlessStarting} render={<Button size="sm" variant="outline" />}><PlatformIcon data-icon="inline-start" icon={Bot} />Generate proposal</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Generate a proposal for issue #{issue.number}?</AlertDialogTitle><AlertDialogDescription>This starts a headless AI run using your credits. It investigates the issue and may draft a spec, push a code change, or return with a question. It does not open a pull request or deploy the app.</AlertDialogDescription></AlertDialogHeader><FieldGroup><Field><FieldLabel htmlFor="headless-model">Model</FieldLabel><Select disabled={headlessStarting || models.length === 0} onValueChange={onSelectedModelChange} value={selectedModel}><SelectTrigger id="headless-model"><SelectValue placeholder={modelError || "Loading models…"} /></SelectTrigger><SelectContent><SelectGroup>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}{model.changeSize?.short ? ` — ${model.changeSize.short}` : ""}</SelectItem>)}</SelectGroup></SelectContent></Select>{models.length ? <FieldDescription>{models.find((model) => model.id === selectedModel)?.changeSize?.long || "The server validates this model before starting work."}</FieldDescription> : <FieldDescription>{modelError || "Model selection is unavailable."}</FieldDescription>}</Field></FieldGroup><AlertDialogFooter><AlertDialogCancel disabled={headlessStarting}>Cancel</AlertDialogCancel><AlertDialogAction disabled={headlessStarting || !selectedModel} onClick={() => void onStartHeadless?.()}>{headlessStarting ? "Starting…" : "Generate proposal"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> : null}
        {canProposeClose ? <AlertDialog open={closeProposalOpen} onOpenChange={(open) => { if (!open && !closeProposalSubmitting) setCloseReason(""); onCloseProposalOpenChange?.(open) }}><AlertDialogTrigger disabled={closeProposalSubmitting} render={<Button size="sm" variant="outline" />}><PlatformIcon data-icon="inline-start" icon={CircleX} />Propose to close</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Propose closing issue #{issue.number}?</AlertDialogTitle><AlertDialogDescription>This creates a governance proposal. It does not close the GitHub issue now; collaborators vote before the existing server workflow can apply it.</AlertDialogDescription></AlertDialogHeader>{closeProposalError ? <Alert variant="destructive"><AlertTitle>Close proposal was not created</AlertTitle><AlertDescription>{closeProposalError}</AlertDescription></Alert> : null}<FieldGroup><Field><FieldLabel htmlFor="close-issue-reason">Reason (optional)</FieldLabel><Textarea disabled={closeProposalSubmitting} id="close-issue-reason" maxLength={2000} onChange={(event) => setCloseReason(event.target.value)} placeholder="Why should this issue be closed?" value={closeReason} /><FieldDescription>{closeReason.length.toLocaleString()} / 2,000 characters</FieldDescription></Field></FieldGroup><AlertDialogFooter><AlertDialogCancel disabled={closeProposalSubmitting}>Cancel</AlertDialogCancel><AlertDialogAction disabled={closeProposalSubmitting} onClick={submitCloseProposal} variant="destructive"><PlatformIcon data-icon="inline-start" icon={Vote} />{closeProposalSubmitting ? "Creating proposal…" : "Create close proposal"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> : null}
        {closeProposal ? <Button render={<Link to={appDevGovernancePath(slug, closeProposal.id)} />} size="sm" variant="outline"><PlatformIcon data-icon="inline-start" icon={Vote} />Close proposed</Button> : null}
        {issue.htmlUrl ? <Button render={<a href={issue.htmlUrl} rel="noreferrer" target="_blank" />} size="sm" variant="outline"><PlatformIcon data-icon="inline-start" icon={ExternalLink} />View on GitHub</Button> : null}
      </CardFooter>
    </Card>
    <section className="flex flex-col gap-3" aria-labelledby="github-issue-comments"><header className="flex items-center gap-2"><PlatformIcon icon={MessageCircle} /><h2 className="text-xl font-semibold" id="github-issue-comments">GitHub discussion</h2></header><Comments comments={comments} truncated={truncated} /></section>
    {children}
  </div>
}

export function GitHubIssueDetail() {
  const { issueNumber = "", slug = "" } = useParams()
  const navigate = useNavigate()
  const number = Number(issueNumber)
  const [issue, setIssue] = useState<GitHubIssue | null | undefined>(undefined)
  const [comments, setComments] = useState<GitHubIssueComment[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentUsername, setCurrentUsername] = useState<string | null>(null)
  const [canAdminWrite, setCanAdminWrite] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [claimClearingUserId, setClaimClearingUserId] = useState<number | string | null>(null)
  const [claimError, setClaimError] = useState<string | null>(null)
  const [attributes, setAttributes] = useState<Partial<Record<TopicAttributeField, TopicAttributeOptions | null>>>({})
  const [attributeError, setAttributeError] = useState<string | null>(null)
  const [attributeUpdating, setAttributeUpdating] = useState<TopicAttributeField | null>(null)
  const [bountyError, setBountyError] = useState<string | null>(null)
  const [bountyNotice, setBountyNotice] = useState<string | null>(null)
  const [bountyUpdating, setBountyUpdating] = useState(false)
  const [closeProposal, setCloseProposal] = useState<DevIssue | null | undefined>(undefined)
  const [closeProposalError, setCloseProposalError] = useState<string | null>(null)
  const [closeProposalNotice, setCloseProposalNotice] = useState<string | null>(null)
  const [closeProposalOpen, setCloseProposalOpen] = useState(false)
  const [closeProposalSubmitting, setCloseProposalSubmitting] = useState(false)
  const [models, setModels] = useState<DevModel[]>([])
  const [modelError, setModelError] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState("")
  const [headlessOpen, setHeadlessOpen] = useState(false)
  const [headlessStarting, setHeadlessStarting] = useState(false)
  const [headlessCloning, setHeadlessCloning] = useState(false)
  const [headlessError, setHeadlessError] = useState<string | null>(null)
  const [headlessNotice, setHeadlessNotice] = useState<string | null>(null)
  const [creatingSession, setCreatingSession] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)

  useEffect(() => {
    if (!Number.isSafeInteger(number) || number <= 0) { setIssue(null); return }
    const controller = new AbortController()
    setIssue(undefined); setComments(null); setTruncated(false); setError(null)
    getGitHubIssues(slug, controller.signal).then((result) => {
      const match = result.issues.find((candidate) => candidate.number === number) || null
      setIssue(match)
      if (!match) return null
      return getGitHubIssueComments(slug, number, controller.signal).then((response) => { setComments(response.comments || []); setTruncated(Boolean(response.truncated)) })
    }).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return
      setError(cause instanceof Error ? cause.message : "Unable to load this GitHub issue")
    })
    return () => controller.abort()
  }, [number, slug])

  useEffect(() => {
    const controller = new AbortController()
    void getCurrentUser(controller.signal).then((user) => {
      if (controller.signal.aborted) return
      setCurrentUsername(user.username || null)
      setCanAdminWrite(user.canAdminWrite === true)
    }).catch(() => {
      if (controller.signal.aborted) return
      setCurrentUsername(null)
      setCanAdminWrite(false)
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void getDevModels(controller.signal).then(({ defaultModel, models: availableModels }) => {
      if (controller.signal.aborted) return
      setModels(availableModels)
      const stored = readBrowserPreference("usernode:dc:model")?.trim() || ""
      setSelectedModel(availableModels.some((model) => model.id === stored) ? stored : defaultModel)
      setModelError(null)
    }).catch((cause) => {
      if (!controller.signal.aborted) setModelError(cause instanceof Error ? cause.message : "Model selection is unavailable.")
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!issue || !currentUsername) { setAttributes({}); return }
    const controller = new AbortController()
    setAttributes({})
    setAttributeError(null)
    const fields: TopicAttributeField[] = ["priority", "category", "assignee"]
    void Promise.allSettled(fields.map((field) => getGitHubIssueAttribute(slug, issue.number, field, controller.signal))).then((results) => {
      if (controller.signal.aborted) return
      const next: Partial<Record<TopicAttributeField, TopicAttributeOptions | null>> = {}
      let unavailable = false
      results.forEach((result, index) => {
        const field = fields[index]
        if (result.status === "fulfilled") next[field] = result.value
        else { next[field] = null; unavailable = true }
      })
      setAttributes(next)
      if (unavailable) setAttributeError("Some community signals could not be loaded.")
    })
    return () => controller.abort()
  }, [currentUsername, issue, slug])

  useEffect(() => {
    if (!Number.isSafeInteger(number) || number <= 0 || !currentUsername) {
      setCloseProposal(undefined)
      return
    }
    const controller = new AbortController()
    setCloseProposal(undefined)
    setCloseProposalError(null)
    void getOpenGovernanceIssues(slug, controller.signal).then(({ issues }) => {
      if (controller.signal.aborted) return
      setCloseProposal(issues.find((candidate) =>
        candidate.kind === "close_issue"
        && Number(candidate.payload?.issueNumber) === number
      ) || null)
    }).catch((cause) => {
      if (controller.signal.aborted) return
      setCloseProposalError(cause instanceof Error ? cause.message : "Unable to load issue governance.")
    })
    return () => controller.abort()
  }, [currentUsername, number, slug])

  const rename = async (nextTitle: string) => {
    if (!issue || renaming || isProductionReadOnlyReview) return false
    setRenaming(true); setRenameError(null)
    try {
      const result = await renameGitHubIssue(slug, issue.number, nextTitle)
      setIssue((current) => current ? { ...current, title: result.title } : current)
      return true
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : "Unable to update the issue title.")
      return false
    } finally { setRenaming(false) }
  }

  const updateClaim = async (claim: boolean) => {
    if (!issue || claiming || isProductionReadOnlyReview) return
    setClaiming(true); setClaimError(null)
    try {
      if (claim) await claimGitHubIssue(slug, issue.number)
      else await clearMyGitHubIssueClaim(slug, issue.number)
      const fresh = await getGitHubIssues(slug)
      setIssue(fresh.issues.find((candidate) => candidate.number === issue.number) || null)
    } catch (cause) { setClaimError(cause instanceof Error ? cause.message : "Unable to update the in-progress mark.") } finally { setClaiming(false) }
  }

  const clearClaimAsAdmin = async (userId: number | string) => {
    if (!issue || !canAdminWrite || claimClearingUserId !== null || isProductionReadOnlyReview) return
    setClaimClearingUserId(userId)
    setClaimError(null)
    try {
      await clearGitHubIssueClaim(slug, issue.number, userId)
      const fresh = await getGitHubIssues(slug)
      setIssue(fresh.issues.find((candidate) => candidate.number === issue.number) || null)
    } catch (cause) {
      setClaimError(cause instanceof Error ? cause.message : "Unable to clear the in-progress mark.")
    } finally {
      setClaimClearingUserId(null)
    }
  }

  const updateAttribute = async (field: TopicAttributeField, value: string | null) => {
    if (!issue || attributeUpdating !== null || isProductionReadOnlyReview) return false
    setAttributeUpdating(field); setAttributeError(null)
    try {
      const result = value
        ? await setGitHubIssueAttribute(slug, issue.number, field, value)
        : await clearGitHubIssueAttribute(slug, issue.number, field)
      setAttributes((current) => ({ ...current, [field]: result }))
      return true
    } catch (cause) {
      setAttributeError(cause instanceof Error ? cause.message : `Unable to update ${field}.`)
      return false
    } finally {
      setAttributeUpdating(null)
    }
  }

  const giveBounty = async () => {
    if (!issue || issue.my_bounty || bountyUpdating || isProductionReadOnlyReview) return
    setBountyUpdating(true); setBountyError(null); setBountyNotice(null)
    try {
      const result = await giveGitHubIssueBounty(slug, issue.number)
      setIssue((current) => current ? { ...current, bounty_count: result.bountyCount, my_bounty: true } : current)
      setBountyNotice(`Your pledge is recorded. ${result.remaining} of ${result.limit} weekly kudos remain.`)
    } catch (cause) { setBountyError(cause instanceof Error ? cause.message : "Unable to record the kudos pledge.") } finally { setBountyUpdating(false) }
  }

  const proposeClose = async (reason: string) => {
    if (!issue || closeProposal !== null || closeProposalSubmitting || isProductionReadOnlyReview) return
    setCloseProposalSubmitting(true)
    setCloseProposalError(null)
    setCloseProposalNotice(null)
    try {
      const created = await createCloseIssueProposal(slug, issue.number, reason)
      setCloseProposal(created)
      setCloseProposalOpen(false)
      setCloseProposalNotice("Collaborators can now review and vote on this proposal. The GitHub issue remains open until governance applies it.")
    } catch (cause) {
      setCloseProposalError(cause instanceof Error ? cause.message : "Unable to create the close proposal.")
    } finally {
      setCloseProposalSubmitting(false)
    }
  }

  const selectHeadlessModel = (model: string | null) => {
    if (!model) return
    setSelectedModel(model)
    writeBrowserPreference("usernode:dc:model", model)
  }

  const startHeadless = async () => {
    if (!issue || !selectedModel || headlessStarting || isProductionReadOnlyReview) return
    setHeadlessStarting(true); setHeadlessError(null); setHeadlessNotice(null)
    try {
      const result = await startHeadlessGitHubIssueSession(slug, issue.number, selectedModel)
      setIssue((current) => current ? { ...current, headless: { ...current.headless, sessionId: result.sessionId, status: "generating" } } : current)
      setHeadlessOpen(false)
      setHeadlessNotice("A proposal is being generated. It runs separately from your Dev chat and will be ready to review here when the server finishes it.")
    } catch (cause) {
      setHeadlessError(cause instanceof Error ? cause.message : "Unable to start the proposal generator.")
      setHeadlessOpen(false)
    } finally { setHeadlessStarting(false) }
  }

  const cloneHeadless = async () => {
    const headlessSessionId = issue?.headless?.sessionId
    if (!issue || headlessSessionId === null || headlessSessionId === undefined || headlessCloning || isProductionReadOnlyReview) return
    setHeadlessCloning(true); setHeadlessError(null); setHeadlessNotice(null)
    try {
      const result = await cloneHeadlessGitHubIssueSession(headlessSessionId)
      navigate(appDevSessionPath(slug, result.sessionId))
    } catch (cause) {
      setHeadlessError(cause instanceof Error ? cause.message : "Unable to start a session from this proposal.")
    } finally { setHeadlessCloning(false) }
  }

  const createSession = async () => {
    if (!issue || creatingSession || isProductionReadOnlyReview) return
    setCreatingSession(true)
    setSessionError(null)
    try {
      const session = await createAppSession(slug, issue.number)
      saveDevSessionDraft(session.id, issueKickoffDraft(issue.number, issue.title, issue.body))
      navigate(appDevSessionPath(slug, session.id))
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : "Unable to create a Dev session.")
    } finally {
      setCreatingSession(false)
    }
  }

  if (error) return <div className="flex flex-1 items-center justify-center p-6" data-testid="github-issue-detail-error"><Alert className="max-w-md" variant="destructive"><AlertTitle>GitHub issue unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert></div>
  if (issue === undefined) return <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-8 sm:px-6"><Skeleton className="h-10 w-32" /><Skeleton className="h-64 w-full" /></div>
  if (issue === null) return <div className="flex flex-1 items-center justify-center p-6" data-testid="github-issue-detail-not-found"><Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={MessageCircle} /></EmptyMedia><EmptyTitle>GitHub issue not found</EmptyTitle><EmptyDescription>It may have been closed, or you may no longer have access to this app.</EmptyDescription></EmptyHeader><Button render={<Link to={appDevPath(slug)} />} variant="outline"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />Back to Dev</Button></Empty></div>
  return <GitHubIssueDetailContent attributeError={attributeError} attributes={attributes} attributeUpdating={attributeUpdating} bountyError={bountyError} bountyNotice={bountyNotice} bountyUpdating={bountyUpdating} canAdminWrite={canAdminWrite} claiming={claiming} claimClearingUserId={claimClearingUserId} claimError={claimError} closeProposal={closeProposal} closeProposalError={closeProposalError} closeProposalNotice={closeProposalNotice} closeProposalOpen={closeProposalOpen} closeProposalSubmitting={closeProposalSubmitting} comments={comments} creatingSession={creatingSession} currentUsername={currentUsername} headlessCloning={headlessCloning} headlessError={headlessError} headlessNotice={headlessNotice} headlessOpen={headlessOpen} headlessStarting={headlessStarting} issue={issue} modelError={modelError} models={models} onAttribute={updateAttribute} onBounty={giveBounty} onClaim={updateClaim} onClearClaim={clearClaimAsAdmin} onCloneHeadless={cloneHeadless} onCloseProposal={proposeClose} onCloseProposalOpenChange={setCloseProposalOpen} onCreateSession={createSession} onHeadlessOpenChange={setHeadlessOpen} onRename={rename} onSelectedModelChange={selectHeadlessModel} onStartHeadless={startHeadless} renaming={renaming} renameError={renameError} selectedModel={selectedModel} sessionError={sessionError} slug={slug} truncated={truncated}>
    <TopicDiscussionTranscript slug={slug} threadRef={issue.number} threadType="issue" />
  </GitHubIssueDetailContent>
}
