import { ArrowLeft, Columns3, List, MessageCircle, Plus, UsersRound } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { PlatformIcon } from "@/components/platform-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DevBoard, type DevPmMove, type DevWorkspaceView } from "@/features/dev/dev-board"
import { createAppSession, getApp, type AppDetail } from "@/lib/apps-api"
import { readBrowserPreference, writeBrowserPreference } from "@/lib/browser-preferences"
import { clearDevPmAssignee, getDevBoardSnapshot, getMergedBoardPage, saveDevBoardOrder, saveDevPmOrder, setDevPmAssignee, type DevBoardSnapshot } from "@/lib/dev-board-api"
import { appDetailsPath, appDevChatPath, appDevSessionPath } from "@/lib/routes"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"
import { subscribeGlobalUpdates } from "@/lib/session-events"

const DEV_VIEW_STORAGE_PREFIX = "social-vibecoding:dev-view:"

function isDevWorkspaceView(value: string | null): value is DevWorkspaceView {
  return value === "list" || value === "kanban" || value === "pm"
}

function defaultDevWorkspaceView() {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches ? "kanban" : "list"
}

function resolveDevWorkspaceView(slug: string, search: string): DevWorkspaceView {
  const override = new URLSearchParams(search).get("view")
  if (isDevWorkspaceView(override)) return override
  const saved = readBrowserPreference(`${DEV_VIEW_STORAGE_PREFIX}${slug}`)
  if (isDevWorkspaceView(saved)) return saved
  return defaultDevWorkspaceView()
}

export function AppDev() {
  const { slug = "" } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [app, setApp] = useState<AppDetail | null>(null)
  const [board, setBoard] = useState<DevBoardSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creationError, setCreationError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [loadingMerged, setLoadingMerged] = useState(false)
  const [mergedError, setMergedError] = useState<string | null>(null)
  const [view, setView] = useState<DevWorkspaceView>(() => resolveDevWorkspaceView(slug, location.search))

  useEffect(() => {
    setView(resolveDevWorkspaceView(slug, location.search))
  }, [location.search, slug])

  const selectView = (next: string | null) => {
    if (!isDevWorkspaceView(next)) return
    writeBrowserPreference(`${DEV_VIEW_STORAGE_PREFIX}${slug}`, next)
    setView(next)
    const parameters = new URLSearchParams(location.search)
    parameters.delete("view")
    navigate({ pathname: location.pathname, search: parameters.size ? `?${parameters}` : "" }, { replace: true })
  }

  const createSession = async () => {
    if (!app || creating || isProductionReadOnlyReview) return
    setCreationError(null)
    setCreating(true)
    try {
      const session = await createAppSession(app.slug)
      navigate(appDevSessionPath(app.slug, session.id))
    } catch (cause) {
      setCreationError(cause instanceof Error ? cause.message : "Unable to create a Dev session")
    } finally {
      setCreating(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    Promise.all([getApp(slug, controller.signal), getDevBoardSnapshot(slug, controller.signal)])
      .then(([appResponse, boardResponse]) => { if (!cancelled) { setApp(appResponse.app); setBoard(boardResponse) } })
      .catch((cause: unknown) => {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        setError(cause instanceof Error ? cause.message : "Unable to load the Dev overview")
      })
    return () => { cancelled = true; controller.abort() }
  }, [slug])

  useEffect(() => {
    let disposed = false
    let refreshPending = false
    const refresh = () => {
      if (disposed || refreshPending) return
      refreshPending = true
      getDevBoardSnapshot(slug)
        .then((snapshot) => { if (!disposed) setBoard(snapshot) })
        .catch(() => undefined)
        .finally(() => { refreshPending = false })
    }
    const unsubscribe = subscribeGlobalUpdates({
      onBoardOrderUpdate: (event) => {
        if (event.appSlug === slug) refresh()
      },
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [slug])

  const persistBoardOrder = async (column: "issues" | "review", order: DevBoardSnapshot["order"]["issues"]) => {
    const nextOrder = await saveDevBoardOrder(slug, column, order)
    setBoard((current) => current ? { ...current, order: nextOrder } : current)
  }

  const persistPmMove = async ({
    target,
    sourceAssignee,
    destinationAssignee,
    sourceOrder,
    destinationOrder,
  }: DevPmMove) => {
    const sourceKey = sourceAssignee?.trim().toLocaleLowerCase() || null
    const destinationKey = destinationAssignee?.trim().toLocaleLowerCase() || null
    try {
      if (sourceKey !== destinationKey) {
        if (destinationAssignee) await setDevPmAssignee(slug, target, destinationAssignee)
        else await clearDevPmAssignee(slug, target)
      }
      if (destinationAssignee) await saveDevPmOrder(slug, destinationAssignee, destinationOrder)
      if (sourceAssignee && sourceKey !== destinationKey) await saveDevPmOrder(slug, sourceAssignee, sourceOrder)
    } catch (cause) {
      getDevBoardSnapshot(slug).then(setBoard).catch(() => undefined)
      throw cause
    }
    setBoard(await getDevBoardSnapshot(slug))
  }

  const loadMoreMerged = async () => {
    const last = board?.merged.at(-1)
    if (!board || !last || loadingMerged || !board.mergedHasMore) return
    setLoadingMerged(true)
    setMergedError(null)
    try {
      const page = await getMergedBoardPage(slug, {
        createdAt: last.created_at,
        id: last.id,
        rowType: last.row_type || "pr",
      })
      setBoard((current) => {
        if (!current) return current
        const seen = new Set(current.merged.map((item) => `${item.row_type || "pr"}:${item.id}`))
        const next = page.merged.filter((item) => !seen.has(`${item.row_type || "pr"}:${item.id}`))
        return {
          ...current,
          merged: [...current.merged, ...next],
          mergedTotal: page.total,
          mergedHasMore: page.hasMore,
        }
      })
    } catch (cause) {
      setMergedError(cause instanceof Error ? cause.message : "Unable to load older completed work.")
    } finally {
      setLoadingMerged(false)
    }
  }

  return <main className="isolate mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6 lg:px-8" data-testid="app-dev">
    <Button className="w-fit" render={<Link to={appDetailsPath(slug)} />} variant="ghost"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />App details</Button>
    {error ? <Alert variant="destructive"><AlertTitle>Dev overview unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!app && !error ? <Skeleton className="h-32 w-full" /> : null}
    {app ? <header className="flex flex-col gap-4"><div className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-2"><h2 className="text-balance text-3xl font-semibold tracking-tight">{app.name} Dev</h2><p className="text-base text-muted-foreground text-pretty">Your development sessions, work, and review activity for this app.</p></div><div className="flex flex-wrap gap-2"><Button render={<Link aria-label={`Open ${app.name} discussion`} to={appDevChatPath(app.slug)} />} variant="outline"><PlatformIcon data-icon="inline-start" icon={MessageCircle} />Discussion</Button><Button aria-label={`Create a session in ${app.name}`} disabled={creating || isProductionReadOnlyReview} onClick={createSession} type="button"><PlatformIcon data-icon="inline-start" icon={Plus} />{creating ? "Creating…" : "New session"}</Button></div></div><ToggleGroup aria-label="Dev workspace view" onValueChange={(values) => selectView(values[0] ?? null)} size="sm" spacing={0} value={[view]} variant="outline"><ToggleGroupItem aria-label="List view" value="list"><PlatformIcon data-icon="inline-start" icon={List} /><span className="hidden sm:inline">List</span></ToggleGroupItem><ToggleGroupItem aria-label="Kanban view" value="kanban"><PlatformIcon data-icon="inline-start" icon={Columns3} /><span className="hidden sm:inline">Board</span></ToggleGroupItem><ToggleGroupItem aria-label="Tasks by assignee view" value="pm"><PlatformIcon data-icon="inline-start" icon={UsersRound} /><span className="hidden sm:inline">By person</span></ToggleGroupItem></ToggleGroup></header> : null}
    {isProductionReadOnlyReview ? <Alert><AlertTitle>Production review mode</AlertTitle><AlertDescription>Existing Dev sessions can be reviewed here, but creating a session is disabled.</AlertDescription></Alert> : null}
    {creationError ? <Alert variant="destructive"><AlertTitle>Could not create a Dev session</AlertTitle><AlertDescription>{creationError}</AlertDescription></Alert> : null}
    {board === null && !error ? <div className="flex flex-col gap-3"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div> : null}
    {board ? <DevBoard canReorder={Boolean(app?.can_collaborate) && !isProductionReadOnlyReview} loadingMore={loadingMerged} mergedError={mergedError} mode={view} onLoadMore={() => void loadMoreMerged()} onPersistOrder={persistBoardOrder} onPersistPmMove={persistPmMove} slug={slug} snapshot={board} /> : null}
  </main>
}
