import { LoaderCircle, LockKeyhole, LockKeyholeOpen, UsersRound } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { AppContextChrome, appContextState } from "@/features/apps/app-context-chrome"
import { AppIdentity } from "@/features/apps/app-identity"
import { AppShareSheet } from "@/features/apps/app-share-sheet"
import { getApp, getPublicAppContributors, proposeAppRename, setAppChangeLock, setAppFavorite, type AppDetail, type PublicAppContributor } from "@/lib/apps-api"
import { createAppShortcutRequest } from "@/lib/app-shortcut-contract"
import { getCurrentUser } from "@/lib/auth-api"
import {
  addNativeHomeScreenShortcut,
  getNativeBridgeInfo,
  getNativeHomeScreenShortcutSupport,
  type NativeBridgeInfo,
  type NativeHomeScreenShortcutSupport,
} from "@/lib/native-bridge"
import { appDevPath, appDevSessionPath, appMembersPath, appOpenPath } from "@/lib/routes"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import { PlatformIcon } from "@/components/platform-icon"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

function DetailSkeleton() {
  return <div className="space-y-4"><Skeleton className="h-8 w-32" /><Skeleton className="h-72 w-full" /></div>
}

function favoriteAction(app: AppDetail) {
  if (app.is_collaborator) {
    const add = app.your_apps_hidden
    return { desired: add, label: add ? "Save to Your apps" : "Remove from Your apps", success: add ? `${app.name} was saved to Your apps.` : `${app.name} was removed from Your apps.` }
  }
  const add = !app.is_favorited
  return { desired: add, label: add ? "Save to Your apps" : "Remove from Your apps", success: add ? `${app.name} was saved to Your apps.` : `${app.name} was removed from Your apps.` }
}

function initials(username: string) {
  return username.trim().slice(0, 2).toUpperCase() || "?"
}

export function AppDetails() {
  const { slug = "" } = useParams()
  const navigate = useNavigate()
  const [app, setApp] = useState<AppDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canAdminWrite, setCanAdminWrite] = useState(false)
  const [lockTarget, setLockTarget] = useState<boolean | null>(null)
  const [locking, setLocking] = useState(false)
  const [lockError, setLockError] = useState<string | null>(null)
  const [contributors, setContributors] = useState<PublicAppContributor[] | null | undefined>(undefined)
  const [contributorsError, setContributorsError] = useState<string | null>(null)
  const [savingFavorite, setSavingFavorite] = useState(false)
  const [favoriteError, setFavoriteError] = useState<string | null>(null)
  const [favoriteSuccess, setFavoriteSuccess] = useState<string | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState("")
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const shortcutBridgeInfo = useRef<NativeBridgeInfo | null>(null)
  const [shortcutSupport, setShortcutSupport] = useState<NativeHomeScreenShortcutSupport | null>(null)
  const [addingShortcut, setAddingShortcut] = useState(false)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const [shortcutSuccess, setShortcutSuccess] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getApp(slug, controller.signal)
      .then(({ app: receivedApp }) => setApp(receivedApp))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        setError(cause instanceof Error ? cause.message : "Unable to load app")
      })
    return () => controller.abort()
  }, [slug])

  useEffect(() => {
    const controller = new AbortController()
    setContributors(undefined)
    setContributorsError(null)
    getPublicAppContributors(slug, controller.signal)
      .then(setContributors)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        setContributorsError(cause instanceof Error ? cause.message : "Unable to load contributors")
      })
    return () => controller.abort()
  }, [slug])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void getCurrentUser(controller.signal)
      .then((user) => { if (!cancelled) setCanAdminWrite(user.canAdminWrite === true) })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        if (!cancelled) setCanAdminWrite(false)
      })
    return () => { cancelled = true; controller.abort() }
  }, [])

  useEffect(() => {
    let cancelled = false
    void getNativeBridgeInfo().then(async (info) => {
      if (!info || cancelled) return
      const support = await getNativeHomeScreenShortcutSupport(info)
      if (cancelled || !support) return
      shortcutBridgeInfo.current = info
      setShortcutSupport(support)
    })
    return () => { cancelled = true }
  }, [])

  const canChangeLock = canAdminWrite && !isProductionReadOnlyReview
  const updateLock = async () => {
    if (!app || lockTarget === null || !canChangeLock || locking) return
    setLocking(true)
    setLockError(null)
    try {
      const result = await setAppChangeLock(app.slug, lockTarget)
      setApp((current) => current ? { ...current, locked: result.locked } : current)
      setLockTarget(null)
    } catch (cause) {
      setLockError(cause instanceof Error ? cause.message : "Unable to update the change lock.")
    } finally {
      setLocking(false)
    }
  }

  const updateFavorite = async () => {
    if (!app || savingFavorite || isProductionReadOnlyReview) return
    const action = favoriteAction(app)
    setFavoriteError(null)
    setFavoriteSuccess(null)
    setSavingFavorite(true)
    try {
      const result = await setAppFavorite(app.slug, action.desired)
      setApp((current) => current ? {
        ...current,
        is_favorited: result.is_favorited,
        your_apps_hidden: current.is_collaborator ? !action.desired : current.your_apps_hidden,
      } : current)
      setFavoriteSuccess(action.success)
    } catch (cause) {
      setFavoriteError(cause instanceof Error ? cause.message : "Unable to update Your apps")
    } finally {
      setSavingFavorite(false)
    }
  }

  const proposeRename = async () => {
    const nextName = renameValue.trim()
    if (!app || !nextName || renaming || isProductionReadOnlyReview) return
    setRenaming(true)
    setRenameError(null)
    try {
      const result = await proposeAppRename(app.slug, nextName)
      setRenameOpen(false)
      navigate(appDevSessionPath(app.slug, result.sessionId))
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : "Unable to create the rename proposal.")
    } finally {
      setRenaming(false)
    }
  }

  const addShortcut = async () => {
    if (!app || !shortcutBridgeInfo.current || !shortcutSupport || addingShortcut) return
    setAddingShortcut(true)
    setShortcutError(null)
    setShortcutSuccess(null)
    try {
      const request = createAppShortcutRequest(app, { origin: window.location.origin })
      await addNativeHomeScreenShortcut(shortcutBridgeInfo.current, request)
      setShortcutSuccess(
        shortcutSupport.mechanism === "widget"
          ? `${app.name} was added to the Usernode widget.`
          : `${app.name} was added to your phone home screen.`
      )
    } catch (cause) {
      setShortcutError(
        cause instanceof Error ? cause.message : "Usernode could not add this app shortcut."
      )
    } finally {
      setAddingShortcut(false)
    }
  }

  return (
    <div className="isolate flex w-full flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="app-details">
      {error ? <Alert variant="destructive"><AlertTitle>App unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {!app && !error ? <DetailSkeleton /> : null}
      {app ? <AppContextChrome app={app} mode="use" state={appContextState(app)} /> : null}
      {app && isProductionReadOnlyReview ? <Alert data-testid="app-details-production-review"><AlertTitle>Read-only</AlertTitle><AlertDescription>Saving to Your apps, renaming, and change-approval updates are unavailable.</AlertDescription></Alert> : null}
      {app ? (
        <Card>
          <CardHeader className="gap-5 sm:flex-row sm:items-start">
            <AppIdentity app={app} />
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-balance text-2xl tracking-tight">{app.name}</CardTitle>
                <Badge variant={app.status === "running" ? "secondary" : "outline"}>{app.status.replaceAll("_", " ")}</Badge>
              </div>
              <CardDescription className="text-base text-pretty">{app.tagline || app.description || "Open this app in Usernode."}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p className="tabular-nums">{app.active_users} active people</p>
            <p>{app.view_visibility === "private" ? "Private to its members" : "Available to the community"}</p>
            {app.missingSecrets?.length ? <Alert><AlertTitle>Configuration required</AlertTitle><AlertDescription>This app needs secrets before it can run.</AlertDescription></Alert> : null}
            {app.lastFailure?.reason ? <Alert variant="destructive"><AlertTitle>Latest build failed</AlertTitle><AlertDescription>{app.lastFailure.reason}</AlertDescription></Alert> : null}
          </CardContent>
          <CardFooter className="flex flex-col items-start gap-3">
            <ButtonGroup aria-label={`${app.name} actions`} data-testid="app-actions" className="flex-wrap">
              <Button disabled={app.status !== "running" || (!app.self_hosted && !app.url)} render={<Link aria-label={`Open ${app.name}`} to={appOpenPath(app.slug)} />}>
                Open app
              </Button>
              {app.can_collaborate !== false ? <><ButtonGroupSeparator /><Button render={<Link aria-label={`Improve ${app.name}`} to={appDevPath(app.slug)} />} variant="secondary">Improve app</Button></> : null}
              {app.can_collaborate !== false ? <><ButtonGroupSeparator /><Button render={<Link aria-label={`Manage ${app.name} collaborators`} to={appMembersPath(app.slug)} />} variant="outline">Collaborators</Button></> : null}
              {app.can_manage ? <><ButtonGroupSeparator /><Button disabled={isProductionReadOnlyReview} onClick={() => { setRenameValue(app.name); setRenameError(null); setRenameOpen(true) }} type="button" variant="outline">Rename</Button></> : null}
              {app.url ? <><ButtonGroupSeparator /><AppShareSheet appName={app.name} url={app.url} /></> : null}
              {shortcutSupport ? (
                <>
                  <ButtonGroupSeparator />
                  <Button
                    disabled={addingShortcut}
                    onClick={() => void addShortcut()}
                    type="button"
                    variant="outline"
                  >
                    {addingShortcut ? <PlatformIcon className="animate-spin" data-icon="inline-start" icon={LoaderCircle} /> : null}
                    {addingShortcut
                      ? "Adding…"
                      : shortcutSupport.mechanism === "widget"
                        ? "Add to Usernode widget"
                        : "Add to phone home screen"}
                  </Button>
                </>
              ) : null}
              <ButtonGroupSeparator />
              <Button disabled={savingFavorite || isProductionReadOnlyReview} onClick={() => void updateFavorite()} type="button" variant="outline">
                {savingFavorite ? <PlatformIcon className="animate-spin" data-icon="inline-start" icon={LoaderCircle} /> : null}
                {savingFavorite ? "Saving…" : favoriteAction(app).label}
              </Button>
            </ButtonGroup>
            {favoriteError ? <Alert variant="destructive"><AlertTitle>Could not update Your apps</AlertTitle><AlertDescription>{favoriteError}</AlertDescription></Alert> : null}
            {shortcutError ? <Alert variant="destructive"><AlertTitle>Shortcut wasn't added</AlertTitle><AlertDescription>{shortcutError}</AlertDescription></Alert> : null}
            {shortcutSuccess ? <Alert role="status"><AlertTitle>Shortcut added</AlertTitle><AlertDescription>{shortcutSuccess}</AlertDescription></Alert> : null}
            <p aria-live="polite" className="sr-only">{favoriteSuccess}</p>
          </CardFooter>
        </Card>
      ) : null}
      {app ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><PlatformIcon icon={UsersRound} />Contributors</CardTitle>
            <CardDescription>People who created, collaborate on, or have merged work into this public app.</CardDescription>
          </CardHeader>
          <CardContent>
            {contributors === undefined ? <div className="flex gap-2"><Skeleton className="size-8 rounded-full" /><Skeleton className="h-8 w-40" /></div> : null}
            {contributorsError ? <Alert variant="destructive"><AlertTitle>Contributors unavailable</AlertTitle><AlertDescription>{contributorsError}</AlertDescription></Alert> : null}
            {contributors === null ? <p className="text-sm text-muted-foreground">This app does not expose a public contributor list.</p> : null}
            {contributors?.length === 0 ? <p className="text-sm text-muted-foreground">No public contributors yet.</p> : null}
            {contributors?.length ? <ul className="grid gap-3 sm:grid-cols-2" aria-label={`${app.name} contributors`}>{contributors.map((contributor) => <li className="flex items-center gap-3" key={contributor.user_id}><Avatar size="sm"><AvatarFallback>{initials(contributor.username)}</AvatarFallback></Avatar><span className="text-sm font-medium">@{contributor.username}</span></li>)}</ul> : null}
          </CardContent>
        </Card>
      ) : null}
      {app && canAdminWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>Change approval</CardTitle>
            <CardDescription>
              {app.locked
                ? "This app is locked. Community-approved changes also need an administrator yes vote before they can merge."
                : "Community-approved changes can merge without an additional administrator yes vote."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {lockError ? <Alert variant="destructive"><AlertTitle>Could not update the change lock</AlertTitle><AlertDescription>{lockError}</AlertDescription></Alert> : null}
            <Button disabled={!canChangeLock || locking} onClick={() => setLockTarget(!app.locked)} type="button" variant={app.locked ? "outline" : "default"}>
              <PlatformIcon data-icon="inline-start" icon={app.locked ? LockKeyholeOpen : LockKeyhole} />
              {app.locked ? "Unlock changes" : "Require an admin approval"}
            </Button>
          </CardContent>
        </Card>
      ) : null}
      <AlertDialog onOpenChange={(open) => { if (!open && !locking) setLockTarget(null) }} open={lockTarget !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{lockTarget ? "Require an admin approval?" : "Unlock changes?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {lockTarget
                ? "Community-approved changes will additionally require an administrator yes vote before they can merge."
                : "Community-approved changes will no longer require an additional administrator yes vote."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={locking}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={locking || !canChangeLock} onClick={() => void updateLock()} type="button" variant={lockTarget ? "default" : "destructive"}>
              <PlatformIcon data-icon="inline-start" icon={locking ? LoaderCircle : lockTarget ? LockKeyhole : LockKeyholeOpen} className={locking ? "animate-spin" : undefined} />
              {locking ? "Saving…" : lockTarget ? "Require approval" : "Unlock changes"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog onOpenChange={(open) => { if (!open && !renaming) setRenameOpen(false) }} open={renameOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Propose a new app name</AlertDialogTitle>
            <AlertDialogDescription>This creates a GitHub-backed manifest proposal. The name changes only after the normal vote, merge, and deployment lifecycle completes.</AlertDialogDescription>
          </AlertDialogHeader>
          <label className="grid gap-2 text-sm font-medium" htmlFor="app-rename">New name<Input disabled={renaming} id="app-rename" maxLength={80} minLength={3} onChange={(event) => setRenameValue(event.target.value)} value={renameValue} /></label>
          {renameError ? <Alert variant="destructive"><AlertTitle>Rename proposal was not created</AlertTitle><AlertDescription>{renameError}</AlertDescription></Alert> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={renaming}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={renaming || renameValue.trim().length < 3 || isProductionReadOnlyReview} onClick={() => void proposeRename()}>{renaming ? "Creating proposal…" : "Create rename proposal"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
