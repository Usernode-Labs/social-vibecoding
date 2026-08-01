import { useEffect, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"

import { ActionLink } from "@/components/action-link"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { AppTopBar } from "@/features/apps/app-top-bar"
import { DevBoard, type DevPmMove, type DevWorkspaceView } from "@/features/dev/dev-board"
import { createAppSession, getApp, type AppDetail } from "@/lib/apps-api"
import { readBrowserPreference, writeBrowserPreference } from "@/lib/browser-preferences"
import { clearDevPmAssignee, getDevBoardSnapshot, getMergedBoardPage, saveDevBoardOrder, saveDevPmOrder, setDevPmAssignee, type DevBoardSnapshot } from "@/lib/dev-board-api"
import { appDevChatPath, appDevSessionPath } from "@/lib/routes"
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
      setCreationError(cause instanceof Error ? cause.message : "Could not create a session")
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
        setError(cause instanceof Error ? cause.message : "Improve didn’t load")
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

  return <div className="isolate flex w-full flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6 lg:px-8" data-testid="app-dev">
    <AppTopBar app={app} fallbackTitle="Improve" mode="improve" />
    <div className="flex w-full flex-col gap-6" data-testid="app-dev-content">
      {error ? <Alert variant="destructive"><AlertTitle>Improve didn’t load</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {!app && !error ? <Skeleton className="h-32 w-full" /> : null}
      {app ? <header className="flex flex-col gap-4"><div className="flex flex-wrap items-start justify-end gap-4"><div className="flex flex-wrap gap-2"><ActionLink aria-label={`Open ${app.name} discussion`} to={appDevChatPath(app.slug)} variant="outline">Discussion</ActionLink><Button aria-label={`Create a session in ${app.name}`} disabled={creating || isProductionReadOnlyReview} onClick={createSession} type="button">{creating ? "Creating…" : "New session"}</Button></div></div><ToggleGroup aria-label="Improve workspace view" onValueChange={(values) => selectView(values[0] ?? null)} size="sm" spacing={0} value={[view]} variant="outline"><ToggleGroupItem aria-label="List view" value="list">List</ToggleGroupItem><ToggleGroupItem aria-label="Kanban view" value="kanban">Board</ToggleGroupItem><ToggleGroupItem aria-label="Tasks by assignee view" value="pm">By person</ToggleGroupItem></ToggleGroup></header> : null}
      {isProductionReadOnlyReview ? <Alert><AlertTitle>Read-only</AlertTitle><AlertDescription>Creating sessions and changing work order or assignees are unavailable.</AlertDescription></Alert> : null}
      {creationError ? <Alert variant="destructive"><AlertTitle>Could not create a session</AlertTitle><AlertDescription>{creationError}</AlertDescription></Alert> : null}
      {board === null && !error ? <div className="flex flex-col gap-3"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div> : null}
      {board ? <DevBoard canReorder={Boolean(app?.can_collaborate) && !isProductionReadOnlyReview} loadingMore={loadingMerged} mergedError={mergedError} mode={view} onLoadMore={() => void loadMoreMerged()} onPersistOrder={persistBoardOrder} onPersistPmMove={persistPmMove} slug={slug} snapshot={board} /> : null}
    </div>
  </div>
}
