import { ChevronDown, LoaderCircle, ShieldAlert, UsersRound } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { ActionLink } from "@/components/action-link"
import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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

function MemberRow({
  canRemove,
  currentUser,
  member,
  removing,
  onRemove,
}: {
  canRemove: boolean
  currentUser: CurrentUser | null
  member: Collaborator
  removing: boolean
  onRemove: (member: Collaborator) => void
}) {
  const action = memberAction(member, currentUser)
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 first:pt-0 last:pb-0 sm:px-6">
      <Avatar><AvatarFallback>{initials(member.username)}</AvatarFallback></Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">@{member.username}</p>
          {member.isCreator ? <Badge variant="secondary">Creator</Badge> : null}
          {member.status === "invited" ? <Badge variant="outline">Invited</Badge> : null}
        </div>
        {member.status === "invited" && member.invitedBy ? <p className="text-sm text-muted-foreground">Invited by @{member.invitedBy}</p> : null}
      </div>
      {canRemove ? <Button disabled={removing} onClick={() => onRemove(member)} size="sm" type="button" variant="outline">{action.label}</Button> : null}
    </li>
  )
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
  const [selectedInviteUsername, setSelectedInviteUsername] = useState<string | null>(null)
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
    if (query.length < 2 || query.toLocaleLowerCase() === selectedInviteUsername || isProductionReadOnlyReview || rosterVisibility !== "private") {
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
  }, [inviteQuery, selectedInviteUsername, slug, rosterVisibility])

  const ready = state.kind === "ready" ? state : null
  const collaborators = ready?.roster.collaborators.filter((member) => member.status !== "invited") ?? []
  const pendingInvites = ready?.roster.collaborators.filter((member) => member.status === "invited") ?? []
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
      setSelectedInviteUsername(null)
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
    <AppTopBar app={ready ? ready.app : null} backTo={ready ? appDetailsPath(ready.app.slug) : "/"} fallbackTitle="Members and visibility" label="Members and visibility" mode="nested" showClose={false} />
    <div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    {state.kind === "loading" ? <MembersSkeleton /> : null}
    {state.kind === "not-found" ? <Empty data-testid="members-not-found"><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={UsersRound} /></EmptyMedia><EmptyTitle>Collaborators unavailable</EmptyTitle><EmptyDescription>This collaborators view is not available to this session.</EmptyDescription></EmptyHeader><ActionLink to="/">Back to apps</ActionLink></Empty> : null}
    {state.kind === "forbidden" ? <Alert variant="destructive"><PlatformIcon icon={ShieldAlert} /><AlertTitle>Collaborator access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Could not load collaborators</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {ready ? <>
      {isProductionReadOnlyReview ? <Alert data-testid="members-production-review"><AlertTitle>Read-only</AlertTitle><AlertDescription>Invitations, collaborator changes, and visibility changes are unavailable.</AlertDescription></Alert> : null}
      <Card className="gap-0 py-0" data-testid="members-surface">
        <section aria-labelledby="members-roster-title" className="py-6">
          <div className="flex items-start justify-between gap-4 px-4 sm:px-6">
            <div>
              <h2 className="font-heading text-base font-medium" id="members-roster-title">{ready.app.name} collaborators</h2>
              <p className="mt-1 text-sm text-muted-foreground">{ready.roster.collabVisibility === "private" ? "Accepted collaborators can build this app." : "Anyone on the platform can collaborate on this app."}</p>
            </div>
            <Badge variant="outline">{collaborators.length}</Badge>
          </div>
          {collaborators.length === 0 ? (
            <Empty className="px-4 pt-5 sm:px-6"><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={UsersRound} /></EmptyMedia><EmptyTitle>No collaborators yet</EmptyTitle><EmptyDescription>Invite someone when this app needs a private building team.</EmptyDescription></EmptyHeader></Empty>
          ) : (
            <ul aria-label={`${ready.app.name} collaborators`} className="mt-5 divide-y divide-border">{collaborators.map((member) => (
              <MemberRow
                canRemove={!member.isCreator && (ready.app.can_manage === true || member.userId === currentUser?.id) && !isProductionReadOnlyReview}
                currentUser={currentUser}
                key={member.userId}
                member={member}
                onRemove={setRemoveTarget}
                removing={removing}
              />
            ))}</ul>
          )}
          {removeError ? <Alert className="mx-4 mt-4 sm:mx-6" variant="destructive"><AlertTitle>Membership was not updated</AlertTitle><AlertDescription>{removeError}</AlertDescription></Alert> : null}
        </section>

        <section aria-labelledby="members-invitations-title" className="border-t py-6">
          <div className="flex items-start justify-between gap-4 px-4 sm:px-6">
            <div>
              <h2 className="font-heading text-base font-medium" id="members-invitations-title">Pending invitations</h2>
              <p className="mt-1 text-sm text-muted-foreground">People invited to join this app before they accept.</p>
            </div>
            <Badge variant="outline">{pendingInvites.length}</Badge>
          </div>
          {pendingInvites.length ? (
            <ul aria-label={`${ready.app.name} pending invitations`} className="mt-5 divide-y divide-border">{pendingInvites.map((member) => (
              <MemberRow
                canRemove={(ready.app.can_manage === true || member.userId === currentUser?.id) && !isProductionReadOnlyReview}
                currentUser={currentUser}
                key={member.userId}
                member={member}
                onRemove={setRemoveTarget}
                removing={removing}
              />
            ))}</ul>
          ) : <p className="px-4 pt-5 text-sm text-muted-foreground sm:px-6">No pending invitations.</p>}
          {ready.roster.collabVisibility === "private" ? (
            <div className="mt-6 border-t px-4 pt-6 sm:px-6">
              <h3 className="font-heading text-sm font-medium">Invite a collaborator</h3>
              <p className="mt-1 text-sm text-muted-foreground">Search by username. Existing collaborators and pending invites are excluded.</p>
              <div className="mt-4">
                <AppMemberInviteForm canInvite={canInvite} error={inviteError} inviting={inviting} onQueryChange={(query) => { setSelectedInviteUsername(null); setInviteQuery(query) }} onSelectSuggestion={(username) => { setSelectedInviteUsername(username.toLocaleLowerCase()); setInviteQuery(username); setSuggestions([]) }} onSubmit={submitInvite} query={inviteQuery} searchError={searchError} suggestions={suggestions} />
              </div>
              {!canInvite && !isProductionReadOnlyReview ? <p className="mt-3 text-sm text-muted-foreground">This app does not use collaborator invitations.</p> : null}
              {inviteSuccess ? <Alert className="mt-4" role="status" tone="positive"><AlertTitle>Invitation sent</AlertTitle><AlertDescription>{inviteSuccess}</AlertDescription></Alert> : null}
            </div>
          ) : <p className="px-4 pt-5 text-sm text-muted-foreground sm:px-6">Open collaboration does not use invitations.</p>}
        </section>

        <details className="group border-t" data-testid="members-permissions-disclosure">
          <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/30 sm:px-6">
            <span className="min-w-0"><span className="block font-heading text-base font-medium">Advanced permissions</span><span className="mt-1 block text-sm text-muted-foreground">Who can build and open this app.</span></span>
            <PlatformIcon className="transition-transform group-open:rotate-180" icon={ChevronDown} size="sm" />
          </summary>
          <div className="border-t bg-muted/15 [&_[data-slot=card]]:gap-4 [&_[data-slot=card]]:rounded-none [&_[data-slot=card]]:bg-transparent [&_[data-slot=card]]:py-6 [&_[data-slot=card]]:shadow-none [&_[data-slot=card]]:ring-0">
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
          </div>
        </details>
      </Card>
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
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedSuggestion, setSelectedSuggestion] = useState(false)
  const normalizedQuery = query.trim().replace(/^@/, "")
  const suggestionStatus = normalizedQuery.length < 2 || selectedSuggestion
    ? ""
    : suggestions.length === 1
      ? "1 invite suggestion available."
      : suggestions.length > 1
        ? `${suggestions.length} invite suggestions available.`
        : "No invite suggestions available."

  return <form aria-label="Invite a collaborator" onSubmit={onSubmit}><FieldGroup><Field data-invalid={!!error}><FieldLabel htmlFor="invite-username">Username</FieldLabel><Input autoComplete="off" disabled={!canInvite || inviting} id="invite-username" onChange={(event) => { setSelectedSuggestion(false); onQueryChange(event.target.value) }} placeholder="Start typing a username" ref={inputRef} value={query} />{searchError ? <FieldError>{searchError}</FieldError> : null}{error ? <FieldError>{error}</FieldError> : null}<FieldDescription>Type at least two characters to search eligible users.</FieldDescription><p aria-atomic="true" aria-live="polite" className="sr-only">{suggestionStatus}</p></Field>{suggestions.length ? <ul aria-label="Invite suggestions" className="flex flex-col gap-1 rounded-lg border p-1">{suggestions.map((user) => <li key={user.id}><Button className="w-full justify-start pointer-coarse:min-h-12" disabled={!canInvite || inviting} onClick={() => { setSelectedSuggestion(true); onSelectSuggestion(user.username); inputRef.current?.focus() }} size="sm" type="button" variant="ghost">@{user.username}</Button></li>)}</ul> : null}<Button disabled={!canInvite || inviting || !query.trim()} type="submit" variant="outline">{inviting ? <PlatformIcon className="animate-spin" data-icon="inline-start" icon={LoaderCircle} /> : null}{inviting ? "Inviting…" : "Send invite"}</Button></FieldGroup></form>
}
