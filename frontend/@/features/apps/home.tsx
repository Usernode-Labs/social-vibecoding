import { useEffect, useId, useMemo, useState } from "react"
import { AppWindow, Bell } from "lucide-react"
import { Link } from "react-router-dom"

import { PageHeader, HeaderLayout } from "@/components/page-header"
import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardHeader } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { appPresentationStatus } from "@/features/apps/app-presentation-status"
import {
  homeActivityItems,
  orderedHomeApps,
  type HomeActivityItem,
} from "@/features/apps/home-explore-model"
import { HomeAppShortcut } from "@/features/apps/home-app-shortcut"
import { listApps, setFavoriteOrder, type AppRecord } from "@/lib/apps-api"
import { getNotificationsPage } from "@/lib/notifications-api"
import { appOpenPath } from "@/lib/routes"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"
import { cn } from "@/lib/utils"

function HomeLoading() {
  const placeholders = ["first", "second", "third"] as const
  return (
    <div aria-label="Loading Home" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" role="status">
      {placeholders.map((placeholder) => (
        <Card aria-hidden="true" key={placeholder} size="sm">
          <CardHeader className="gap-3">
            <Skeleton className="size-12 rounded-xl" />
            <Skeleton className="h-5 w-1/2" />
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}

function HomeEmptyState({ firstRun }: { firstRun: boolean }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PlatformIcon icon={AppWindow} />
        </EmptyMedia>
        <EmptyTitle>{firstRun ? "No dApps yet" : "No shortcuts yet"}</EmptyTitle>
        <EmptyDescription>
          {firstRun
            ? "New dApps will appear in Explore."
            : "Save or join a dApp to keep it here."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link
          className={buttonVariants({ variant: "outline" })}
          to="/explore"
        >
          Explore dApps
        </Link>
      </EmptyContent>
    </Empty>
  )
}

function ActivityLoading() {
  return (
    <div
      aria-label="Loading Activity"
      className="flex flex-col gap-3"
      role="status"
    >
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  )
}

function ActivityPreview({ items }: { items: readonly HomeActivityItem[] }) {
  const headingId = useId()

  if (items.length === 0) return null

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <HeaderLayout
        heading={
          <h2
            className="font-heading text-xl font-medium tracking-tight text-balance"
            id={headingId}
          >
            Needs attention
          </h2>
        }
      />
      <ul className="divide-y divide-border" role="list">
        {items.slice(0, 3).map((item) => (
          <li className="py-3 first:pt-0 last:pb-0" key={item.id}>
            <Link
              className="group flex min-w-0 flex-col gap-0.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
              to="/notifications"
            >
              <p className="font-medium text-pretty group-hover:underline">{item.title}</p>
              {item.detail ? (
                <p className="text-pretty text-base text-muted-foreground sm:text-sm">
                  {item.detail}
                </p>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
      <Link
        className={cn(buttonVariants({ size: "sm", variant: "outline" }), "self-start")}
        to="/notifications"
      >
        View all activity
      </Link>
    </section>
  )
}

export type HomeViewProps = {
  apps: readonly AppRecord[] | null
  activity: readonly HomeActivityItem[] | null
  activityError?: boolean
  error?: boolean
  reordering?: boolean
  orderingSlug?: string | null
  orderError?: string | null
  canReorder?: boolean
  onRetry: () => void
  onActivityRetry: () => void
  onReorderingChange: (reordering: boolean) => void
  onMoveApp: (slug: string, direction: -1 | 1) => void
}

export function HomeView({
  activity,
  activityError = false,
  apps,
  canReorder = true,
  error = false,
  onMoveApp,
  onActivityRetry,
  onReorderingChange,
  onRetry,
  orderError = null,
  orderingSlug = null,
  reordering = false,
}: HomeViewProps) {
  const headingId = useId()
  const homeApps = useMemo(() => orderedHomeApps(apps ?? []), [apps])
  const showReorder = homeApps.length > 1

  return (
    <div
      className="isolate flex w-full flex-1 flex-col gap-8 p-4 antialiased sm:p-6 lg:p-8"
      data-testid="home-route"
    >
      <PageHeader title="Home" />

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Home couldn’t load</AlertTitle>
          <AlertDescription>Try again to load your app shortcuts.</AlertDescription>
          <AlertAction>
            <Button onClick={onRetry} size="sm" type="button" variant="outline">
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {!error && apps === null ? <HomeLoading /> : null}

      {!error && apps !== null && homeApps.length === 0 ? (
        <HomeEmptyState firstRun={apps.length === 0} />
      ) : null}

      {!error && apps !== null && homeApps.length > 0 ? (
        <section aria-labelledby={headingId} className="@container flex flex-col gap-4">
          <HeaderLayout
            action={
              showReorder ? (
                <Button
                  disabled={!canReorder}
                  onClick={() => onReorderingChange(!reordering)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {reordering ? "Done" : "Reorder"}
                </Button>
              ) : undefined
            }
            description={
              reordering ? (
                <p className="text-pretty text-base text-muted-foreground sm:text-sm">
                  Use Earlier and Later to set the order on Home.
                </p>
              ) : undefined
            }
            heading={
              <h2
                className="font-heading text-xl font-medium tracking-tight text-balance"
                id={headingId}
              >
                Your apps
              </h2>
            }
          />

          {orderError ? (
            <Alert variant="destructive">
              <AlertTitle>Order wasn’t saved</AlertTitle>
              <AlertDescription>{orderError}</AlertDescription>
            </Alert>
          ) : null}

          <ol
            aria-label="Your apps"
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
            role="list"
          >
            {homeApps.map((app, index) => (
              <li className="min-w-0" key={app.id}>
                <HomeAppShortcut
                  app={app}
                  href={appOpenPath(app.slug)}
                  reorder={
                    reordering
                      ? {
                          disabled: !canReorder,
                          onMoveEarlier: () => onMoveApp(app.slug, -1),
                          onMoveLater: () => onMoveApp(app.slug, 1),
                          pending: orderingSlug !== null,
                          position: index,
                          total: homeApps.length,
                        }
                      : undefined
                  }
                  status={appPresentationStatus(app.status).status}
                />
              </li>
            ))}
          </ol>

          <Link
            className={cn(buttonVariants({ size: "sm", variant: "outline" }), "self-start")}
            to="/explore"
          >
            Explore dApps
          </Link>
        </section>
      ) : null}

      {activityError ? (
        <Alert>
          <PlatformIcon icon={Bell} />
          <AlertTitle>Activity couldn’t load</AlertTitle>
          <AlertDescription>Try again to check for updates.</AlertDescription>
          <AlertAction>
            <Button
              onClick={onActivityRetry}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {!activityError && activity === null ? <ActivityLoading /> : null}
      {!activityError && activity ? <ActivityPreview items={activity} /> : null}
    </div>
  )
}

export function Home() {
  const [apps, setApps] = useState<AppRecord[] | null>(null)
  const [error, setError] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [reordering, setReordering] = useState(false)
  const [orderingSlug, setOrderingSlug] = useState<string | null>(null)
  const [orderError, setOrderError] = useState<string | null>(null)
  const [activity, setActivity] = useState<HomeActivityItem[] | null>(null)
  const [activityError, setActivityError] = useState(false)
  const [activityReloadToken, setActivityReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setApps(null)
    setError(false)
    void listApps(controller.signal)
      .then(({ apps: receivedApps }) => setApps(receivedApps))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        setError(true)
      })
    return () => controller.abort()
  }, [reloadToken])

  useEffect(() => {
    const controller = new AbortController()
    setActivity(null)
    setActivityError(false)
    void getNotificationsPage(null, controller.signal)
      .then((page) => setActivity(homeActivityItems(page)))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        setActivityError(true)
      })
    return () => controller.abort()
  }, [activityReloadToken])

  const homeApps = orderedHomeApps(apps ?? [])
  const canReorder =
    homeApps.length > 1 && !orderingSlug && !isProductionReadOnlyReview

  const moveApp = async (slug: string, direction: -1 | 1) => {
    if (!apps || orderingSlug || isProductionReadOnlyReview) return
    const currentOrder = homeApps.map((app) => app.slug)
    const from = currentOrder.indexOf(slug)
    const to = from + direction
    if (from < 0 || to < 0 || to >= currentOrder.length) return

    const nextOrder = [...currentOrder]
    ;[nextOrder[from], nextOrder[to]] = [nextOrder[to], nextOrder[from]]
    const snapshot = apps
    setOrderingSlug(slug)
    setOrderError(null)
    setApps((current) =>
      current?.map((app) => {
        const position = nextOrder.indexOf(app.slug)
        return position < 0 ? app : { ...app, favorite_order: position }
      }) ?? null
    )

    try {
      await setFavoriteOrder(nextOrder)
    } catch (cause) {
      setApps(snapshot)
      try {
        const refreshed = await listApps()
        setApps(refreshed.apps)
      } catch {
        // Keep the last known snapshot when reconciliation is unavailable.
      }
      setOrderError(
        cause instanceof Error
          ? cause.message
          : "The previous app order is back."
      )
    } finally {
      setOrderingSlug(null)
    }
  }

  return (
    <HomeView
      activity={activity}
      activityError={activityError}
      apps={apps}
      canReorder={canReorder}
      error={error}
      onMoveApp={(slug, direction) => void moveApp(slug, direction)}
      onActivityRetry={() =>
        setActivityReloadToken((current) => current + 1)
      }
      onReorderingChange={(next) => {
        setReordering(next)
        setOrderError(null)
      }}
      onRetry={() => setReloadToken((current) => current + 1)}
      orderError={orderError}
      orderingSlug={orderingSlug}
      reordering={reordering}
    />
  )
}
