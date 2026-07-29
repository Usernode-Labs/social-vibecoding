import { useEffect, useMemo, useState, type ReactNode } from "react"
import { ArrowLeft, ArrowRight, ListOrdered, Plus, Search, X } from "lucide-react"

import { AppCard } from "@/features/apps/app-card"
import { listApps, setFavoriteOrder, type AppRecord } from "@/lib/apps-api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { PlatformIcon } from "@/components/platform-icon"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

function isYours(app: AppRecord) {
  return (app.is_collaborator && !app.your_apps_hidden) || app.is_favorited
}

function matchesQuery(app: AppRecord, query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [app.name, app.slug, app.tagline, app.description].some((value) => value?.toLowerCase().includes(normalized))
}

function AppSection({ action, children, description, title }: { action?: ReactNode; children: ReactNode; description?: string; title: string }) {
  return (
    <section className="flex flex-col gap-4" aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {description ? <p className="text-base text-pretty text-muted-foreground sm:text-sm">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function CardSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading apps">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="rounded-xl border p-6" key={index}>
          <Skeleton className="size-12 rounded-md" />
          <Skeleton className="mt-6 h-5 w-2/3" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-1/2" />
          <Skeleton className="mt-8 h-9 w-full" />
        </div>
      ))}
    </div>
  )
}

export function AppsHome() {
  const [apps, setApps] = useState<AppRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [reordering, setReordering] = useState(false)
  const [orderingSlug, setOrderingSlug] = useState<string | null>(null)
  const [orderError, setOrderError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    listApps(controller.signal)
      .then(({ apps: receivedApps }) => setApps(receivedApps))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        setError(cause instanceof Error ? cause.message : "Unable to load apps")
      })
    return () => controller.abort()
  }, [])

  const filtered = useMemo(() => (apps || []).filter((app) => matchesQuery(app, query)), [apps, query])
  const favorites = filtered.filter(isYours).sort((left, right) => (left.favorite_order ?? Number.MAX_SAFE_INTEGER) - (right.favorite_order ?? Number.MAX_SAFE_INTEGER))
  const canReorder = favorites.length > 1 && !query.trim() && !isProductionReadOnlyReview

  const moveFavorite = async (slug: string, direction: -1 | 1) => {
    if (!apps || orderingSlug || !canReorder) return
    const currentOrder = favorites.map((app) => app.slug)
    const from = currentOrder.indexOf(slug)
    const to = from + direction
    if (from < 0 || to < 0 || to >= currentOrder.length) return
    const nextOrder = [...currentOrder]
    ;[nextOrder[from], nextOrder[to]] = [nextOrder[to], nextOrder[from]]
    const snapshot = apps
    setOrderingSlug(slug)
    setOrderError(null)
    setApps((current) => current?.map((app) => {
      const position = nextOrder.indexOf(app.slug)
      return position < 0 ? app : { ...app, favorite_order: position }
    }) || null)
    try {
      await setFavoriteOrder(nextOrder)
    } catch (cause) {
      // The local swap is only a responsive preview. Re-read instead of
      // keeping a stale in-memory order when the server rejects or another
      // device has changed the user's personal rail.
      setApps(snapshot)
      try {
        const refreshed = await listApps()
        setApps(refreshed.apps)
      } catch {
        // The known snapshot is still preferable to a blank home screen.
      }
      setOrderError(cause instanceof Error ? cause.message : "The app order could not be saved.")
    } finally {
      setOrderingSlug(null)
    }
  }

  return (
    <div className="isolate mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 antialiased sm:px-6" data-testid="apps-home">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-balance text-2xl font-semibold tracking-tight">Apps</h1>
            <p className="text-base text-pretty text-muted-foreground sm:text-sm">Open something familiar or find something new.</p>
          </div>
          <Button render={<a aria-label="Create an app" href="/react/create" />}>
            <PlatformIcon data-icon="inline-start" icon={Plus} />Create app
          </Button>
        </div>
        <InputGroup>
          <InputGroupAddon><PlatformIcon icon={Search} /></InputGroupAddon>
          <InputGroupInput aria-label="Search apps" name="app-search" onChange={(event) => setQuery(event.target.value)} placeholder="Search apps" value={query} />
        </InputGroup>
      </section>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Apps could not be loaded</AlertTitle>
          <AlertDescription>{error}. Return to the legacy shell while this migration route is being diagnosed.</AlertDescription>
        </Alert>
      ) : null}
      {apps === null && !error ? <CardSkeleton /> : null}

      {apps !== null && !error && filtered.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No matches</EmptyTitle>
            <EmptyDescription>Try an app name or slug.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {favorites.length ? (
        <AppSection
          action={
            <Button disabled={!canReorder && !reordering} onClick={() => { setReordering((current) => !current); setOrderError(null) }} size="sm" type="button" variant={reordering ? "secondary" : "outline"}>
              <PlatformIcon data-icon="inline-start" icon={reordering ? X : ListOrdered} />{reordering ? "Done ordering" : "Reorder"}
            </Button>
          }
          description={reordering ? "Use Earlier and Later to set your personal order. This never changes who can access an app." : "Apps you saved or built."}
          title="Your apps"
        >
          {query.trim() ? <p className="text-base text-muted-foreground sm:text-sm">Clear search to reorder your full personal app list.</p> : null}
          {isProductionReadOnlyReview ? <p className="text-base text-muted-foreground sm:text-sm">Reordering is disabled while reviewing production data.</p> : null}
          {orderError ? <Alert variant="destructive"><AlertTitle>Order was not saved</AlertTitle><AlertDescription>{orderError}</AlertDescription></Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{favorites.map((app, index) => <AppCard app={app} footerActions={reordering ? <div className="flex shrink-0 gap-1"><Button aria-label={`Move ${app.name} earlier`} disabled={index === 0 || orderingSlug !== null || !canReorder} onClick={() => void moveFavorite(app.slug, -1)} size="icon-sm" type="button" variant="outline"><PlatformIcon icon={ArrowLeft} /></Button><Button aria-label={`Move ${app.name} later`} disabled={index === favorites.length - 1 || orderingSlug !== null || !canReorder} onClick={() => void moveFavorite(app.slug, 1)} size="icon-sm" type="button" variant="outline"><PlatformIcon icon={ArrowRight} /></Button></div> : undefined} key={app.id} />)}</div>
        </AppSection>
      ) : null}

      {filtered.length ? (
        <AppSection title={favorites.length ? "All apps" : "Apps"}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{filtered.map((app) => <AppCard app={app} key={app.id} />)}</div>
        </AppSection>
      ) : null}
    </div>
  )
}
