import { LoaderCircle, ShieldAlert, UsersRound } from "lucide-react"
import { useEffect, useState, type FormEvent } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { AppTopBar } from "@/features/apps/app-top-bar"
import { AppVisibilitySettings, type AppVisibilityProposalState, type AppVisibilitySelection } from "@/features/apps/app-visibility-settings"
import { getApp, proposeAppVisibility, type AppDetail } from "@/lib/apps-api"
import { CollaboratorRequestError, getCollaborators, inviteCollaborator, removeCollaborator, searchInviteUsers, type Collaborator, type CollaboratorRoster, type UserSearchResult } from "@/lib/collaborators-api"
import { getCurrentUser, type CurrentUser } from "@/lib/auth-api"
import { appDetailsPath, appDevSessionPath } from "@/lib/routes"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

type MembersState =
  | { kind: "loading" }
  | { kind: "ready"; app: AppDetail; roster: CollaboratorRoster }
  | { kind: "forbidden"; message: string }
  | { kind: "not-found" }
  | { kind: "error"; message: string }

function initials(username: string) {
  return username.trim().slice(0, 2).toUpperCase() || "?"
}

function memberAction(member: Collaborator, currentUser: CurrentUser | null) {
  if (member.status === "invited") return { label: `Revoke @${member.username}`, title: "Revoke pending invite?", description: `@${member.username} will no longer be able to accept this invitation.` }
  if (member.userId === currentUser?.id) return { label: "Leave app", title: "Leave this app?", description: "You will lose collaborator access. You can be invited again by a collaborator." }
  return { label: `Remove @${member.username}`, title: `Remove @${member.username}?`, description: "They will lose collaborator access. The app creator cannot be removed." }
}

function MembersSkeleton() {
  return <div className="flex flex-col gap-4"><Skeleton className="h-10 w-36" /><Skeleton className="h-48 w-full" /><Skeleton className="h-40 w-full" /></div>
}

/**
 * Collaboration membership is intentionally separated from public contributors.
 * The server keeps the creator/admin/self-leave policy authoritative and a 404
 * never tells this route whether an app exists behind a private boundary.
 */
export function AppMembers() {
  const { slug = "" } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<MembersState>({ kind: "loading" })
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [inviteQuery, setInviteQuery] = useState("")
  const [suggestions, setSuggestions] = useState<UserSearchResult[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<Collaborator | null>(null)
  const [visibilityProposal, setVisibilityProposal] = useState<AppVisibilityProposalState>({ kind: "idle" })
  const rosterVisibility = state.kind === "ready" ? state.roster.collabVisibility : null

  useEffect(() => {
    const controller = new AbortController()
    setState({ kind: "loading" })
    setInviteError(null)
    setRemoveError(null)
    setVisibilityProposal({ kind: "idle" })
    // Resolve the collaboration endpoint first. Its 403/404 meaning is the
    // deliberate membership privacy boundary, whereas App Detail's 404 is a
    // broader view-level result and must not race it into a generic error.
    void getCollaborators(slug, controller.signal)
      .then(async (roster) => {
        const { app } = await getApp(slug, controller.signal)
        if (!controller.signal.aborted) setState({ kind: "ready", app, roster })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) return
        if (cause instanceof CollaboratorRequestError && cause.status === 404) {
          setState({ kind: "not-found" })
          return
        }
        if (cause instanceof CollaboratorRequestError && cause.status === 403) {
          setState({ kind: "forbidden", message: cause.message })
          return
        }
        setState({ kind: "error", message: cause instanceof Error ? cause.message : "Unable to load collaborators." })
      })
    return () => controller.abort()
  }, [slug])

  useEffect(() => {
    const controller = new AbortController()
    void getCurrentUser(controller.signal).then(setCurrentUser).catch(() => setCurrentUser(null))
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const query = inviteQuery.trim().replace(/^@/, "")
    setSearchError(null)
    if (query.length < 2 || isProductionReadOnlyReview || rosterVisibility !== "private") {
      setSuggestions([])
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void searchInviteUsers(slug, query, controller.signal).then((users) => {
        if (!controller.signal.aborted) setSuggestions(users)
      }).catch((cause: unknown) => {
        if (controller.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) return
        setSuggestions([])
        setSearchError(cause instanceof Error ? cause.message : "Unable to search users.")
      })
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [inviteQuery, slug, rosterVisibility])

  const ready = state.kind === "ready" ? state : null
  const canInvite = Boolean(ready && ready.roster.collabVisibility === "private" && !ready.app.self_hosted && !isProductionReadOnlyReview)

  async function refreshRoster() {
    if (!ready) return
    const roster = await getCollaborators(slug)
    setState((current) => current.kind === "ready" ? { ...current, roster } : current)
  }

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const username = inviteQuery.trim().replace(/^@/, "")
    if (!username || inviting || !canInvite) return
    setInviting(true)
    setInviteError(null)
    setInviteSuccess(null)
    try {
      const result = await inviteCollaborator(slug, username)
      setInviteQuery("")
      setSuggestions([])
      setInviteSuccess(`Invited @${result.username}.`)
      await refreshRoster()
    } catch (cause) {
      setInviteError(cause instanceof Error ? cause.message : "Unable to send invitation.")
    } finally {
      setInviting(false)
    }
  }

  async function confirmRemoval() {
    if (!removeTarget || removing || isProductionReadOnlyReview) return
    setRemoving(true)
    setRemoveError(null)
    try {
      await removeCollaborator(slug, removeTarget.userId)
      if (removeTarget.userId === currentUser?.id) {
        navigate("/", { replace: true })
        return
      }
      setRemoveTarget(null)
      await refreshRoster()
    } catch (cause) {
      setRemoveError(cause instanceof Error ? cause.message : "Unable to update collaborators.")
    } finally {
      setRemoving(false)
    }
  }

  async function proposeVisibility(selection: AppVisibilitySelection) {
    if (!ready || ready.app.can_manage !== true || ready.app.self_hosted || isProductionReadOnlyReview) return
    setVisibilityProposal({ kind: "submitting" })
    try {
      const result = await proposeAppVisibility(slug, selection)
      setVisibilityProposal({
        kind: "ready",
        existing: result.existing,
        proposalHref: appDevSessionPath(slug, result.sessionId),
        prNumber: result.prNumber ?? null,
      })
    } catch (cause) {
      setVisibilityProposal({
        kind: "error",
        message: cause instanceof Error ? cause.message : "Unable to create the visibility proposal.",
      })
    }
  }

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="app-members">
    <AppTopBar app={ready ? ready.app : null} backTo={ready ? appDetailsPath(ready.app.slug) : "/"} fallbackTitle="Members and visibility" label="Members and visibility" mode="nested" />
    <div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    {state.kind === "loading" ? <MembersSkeleton /> : null}
    {state.kind === "not-found" ? <Empty data-testid="members-not-found"><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={UsersRound} /></EmptyMedia><EmptyTitle>Collaborators unavailable</EmptyTitle><EmptyDescription>This collaborators view is not available to this session.</EmptyDescription></EmptyHeader><Button render={<Link to="/" />} variant="outline">Back to apps</Button></Empty> : null}
    {state.kind === "forbidden" ? <Alert variant="destructive"><PlatformIcon icon={ShieldAlert} /><AlertTitle>Collaborator access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Could not load collaborators</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {ready ? <>
      {isProductionReadOnlyReview ? <Alert data-testid="members-production-review"><AlertTitle>Read-only</AlertTitle><AlertDescription>Invitations, collaborator changes, and visibility changes are unavailable.</AlertDescription></Alert> : null}
      <AppVisibilitySettings
        appName={ready.app.name}
        canManage={ready.app.can_manage === true}
        current={{
          collabVisibility: ready.roster.collabVisibility,
          viewVisibility: ready.roster.viewVisibility,
        }}
        disabled={isProductionReadOnlyReview}
        onPropose={(selection) => void proposeVisibility(selection)}
        proposal={visibilityProposal}
        selfHosted={ready.app.self_hosted === true}
      />
      <Card>
        <CardHeader><CardTitle>{ready.app.name} collaborators</CardTitle><CardDescription>{ready.roster.collabVisibility === "private" ? "Only accepted collaborators can build this app." : "Anyone on the platform can collaborate on this app. Invitations are not needed."}</CardDescription></CardHeader>
        <CardContent>
          {ready.roster.collaborators.length === 0 ? <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={UsersRound} /></EmptyMedia><EmptyTitle>No collaborators yet</EmptyTitle><EmptyDescription>Invite someone when this app needs a private building team.</EmptyDescription></EmptyHeader></Empty> : <ul className="flex flex-col gap-2" aria-label={`${ready.app.name} collaborators`}>{ready.roster.collaborators.map((member) => {
            const action = memberAction(member, currentUser)
            const canRemove = !member.isCreator && (ready.app.can_manage === true || member.userId === currentUser?.id) && !isProductionReadOnlyReview
            return <li className="flex flex-wrap items-center gap-3 rounded-lg border p-3" key={member.userId}>
              <Avatar><AvatarFallback>{initials(member.username)}</AvatarFallback></Avatar>
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-medium">@{member.username}</p>{member.isCreator ? <Badge variant="secondary">Creator</Badge> : null}{member.status === "invited" ? <Badge variant="outline">Invited</Badge> : null}</div>{member.status === "invited" && member.invitedBy ? <p className="text-sm text-muted-foreground">Invited by @{member.invitedBy}</p> : null}</div>
              {canRemove ? <Button disabled={removing} onClick={() => setRemoveTarget(member)} size="sm" type="button" variant="outline">{action.label}</Button> : null}
            </li>
          })}</ul>}
          {removeError ? <Alert className="mt-4" variant="destructive"><AlertTitle>Membership was not updated</AlertTitle><AlertDescription>{removeError}</AlertDescription></Alert> : null}
        </CardContent>
      </Card>
      {ready.roster.collabVisibility === "private" ? <Card>
        <CardHeader><CardTitle>Invite a collaborator</CardTitle><CardDescription>Search by username. Existing collaborators and pending invites won’t appear.</CardDescription></CardHeader>
        <CardContent><AppMemberInviteForm canInvite={canInvite} error={inviteError} inviting={inviting} onQueryChange={setInviteQuery} onSelectSuggestion={(username) => { setInviteQuery(username); setSuggestions([]) }} onSubmit={submitInvite} query={inviteQuery} searchError={searchError} suggestions={suggestions} /></CardContent>
        <CardFooter>{!canInvite && !isProductionReadOnlyReview ? <p className="text-sm text-muted-foreground">This app does not use collaborator invitations.</p> : <p aria-live="polite" className="text-sm text-muted-foreground">{inviteSuccess}</p>}</CardFooter>
      </Card> : null}
    </> : null}
    <AlertDialog onOpenChange={(open) => { if (!open && !removing) setRemoveTarget(null) }} open={removeTarget !== null}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{removeTarget ? memberAction(removeTarget, currentUser).title : "Update collaborator"}</AlertDialogTitle><AlertDialogDescription>{removeTarget ? memberAction(removeTarget, currentUser).description : ""}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel><AlertDialogAction disabled={removing || isProductionReadOnlyReview} onClick={() => void confirmRemoval()} type="button" variant="destructive">{removing ? <PlatformIcon className="animate-spin" data-icon="inline-start" icon={LoaderCircle} /> : null}{removing ? "Updating…" : removeTarget?.status === "invited" ? "Revoke invite" : removeTarget?.userId === currentUser?.id ? "Leave app" : "Remove collaborator"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
    </div>
  </div>
}

export function AppMemberInviteForm({
  canInvite,
  error,
  inviting,
  onQueryChange,
  onSelectSuggestion,
  onSubmit,
  query,
  searchError,
  suggestions,
}: {
  canInvite: boolean
  error: string | null
  inviting: boolean
  onQueryChange: (query: string) => void
  onSelectSuggestion: (username: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  query: string
  searchError: string | null
  suggestions: UserSearchResult[]
}) {
  return <form aria-label="Invite a collaborator" onSubmit={onSubmit}><FieldGroup><Field data-invalid={!!error}><FieldLabel htmlFor="invite-username">Username</FieldLabel><Input autoComplete="off" disabled={!canInvite || inviting} id="invite-username" onChange={(event) => onQueryChange(event.target.value)} placeholder="Start typing a username" value={query} />{searchError ? <FieldError>{searchError}</FieldError> : null}{error ? <FieldError>{error}</FieldError> : null}<FieldDescription>Type at least two characters to search eligible users.</FieldDescription></Field>{suggestions.length ? <ul aria-label="Invite suggestions" className="flex flex-col gap-1 rounded-lg border p-1">{suggestions.map((user) => <li key={user.id}><Button className="w-full justify-start" disabled={!canInvite || inviting} onClick={() => onSelectSuggestion(user.username)} size="sm" type="button" variant="ghost">@{user.username}</Button></li>)}</ul> : null}<Button disabled={!canInvite || inviting || !query.trim()} type="submit">{inviting ? <PlatformIcon className="animate-spin" data-icon="inline-start" icon={LoaderCircle} /> : null}{inviting ? "Inviting…" : "Send invite"}</Button></FieldGroup></form>
}
