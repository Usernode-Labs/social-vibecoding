import { useEffect, useId, useMemo, useState } from "react"
import { Compass, Search } from "lucide-react"
import { Link } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { appPresentationStatus } from "@/features/apps/app-presentation-status"
import { matchesAppQuery } from "@/features/apps/home-explore-model"
import { ExploreAppCard } from "@/features/apps/explore-app-card"
import { listApps, type AppRecord } from "@/lib/apps-api"
import { appDetailsPath } from "@/lib/routes"

function ExploreLoading() {
  const placeholders = [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
  ] as const
  return (
    <div
      aria-label="Loading Explore"
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      role="status"
    >
      {placeholders.map((placeholder) => (
        <Card aria-hidden="true" key={placeholder}>
          <CardHeader className="gap-3">
            <Skeleton className="size-12 rounded-xl" />
            <Skeleton className="h-5 w-1/2" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/3" />
          </CardContent>
          <CardFooter>
            <Skeleton className="h-9 w-full" />
          </CardFooter>
        </Card>
      ))}
    </div>
  )
}

export type ExploreViewProps = {
  apps: readonly AppRecord[] | null
  error?: boolean
  query: string
  onQueryChange: (query: string) => void
  onRetry: () => void
}

export function ExploreView({
  apps,
  error = false,
  onQueryChange,
  onRetry,
  query,
}: ExploreViewProps) {
  const headingId = useId()
  const filteredApps = useMemo(
    () => (apps ?? []).filter((app) => matchesAppQuery(app, query)),
    [apps, query]
  )
  const hasQuery = Boolean(query.trim())

  return (
    <div
      className="isolate flex w-full flex-1 flex-col"
      data-testid="explore-route"
    >
      <TopBar action={
          <Link className={buttonVariants()} to="/create">
            Create dApp
          </Link>
        } title="Explore" /><div className="flex w-full flex-1 flex-col gap-8 p-4 antialiased sm:p-6 lg:p-8">

      <InputGroup>
        <InputGroupInput
          aria-label="Search dApps"
          disabled={apps === null || error}
          name="catalog-search"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search dApps"
          type="search"
          value={query}
        />
        <InputGroupAddon>
          <PlatformIcon icon={Search} />
        </InputGroupAddon>
      </InputGroup>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Explore couldn’t load</AlertTitle>
          <AlertDescription>Try again to load the dApp catalog.</AlertDescription>
          <AlertAction>
            <Button onClick={onRetry} size="sm" type="button" variant="outline">
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {!error && apps === null ? <ExploreLoading /> : null}

      {!error && apps !== null && apps.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlatformIcon icon={Compass} />
            </EmptyMedia>
            <EmptyTitle>No dApps yet</EmptyTitle>
            <EmptyDescription>
              Create the first dApp to start the catalog.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {!error && apps !== null && apps.length > 0 && filteredApps.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlatformIcon icon={Search} />
            </EmptyMedia>
            <EmptyTitle>No matching dApps</EmptyTitle>
            <EmptyDescription>
              Try another name or clear your search.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              onClick={() => onQueryChange("")}
              type="button"
              variant="outline"
            >
              Clear search
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}

      {!error && apps !== null && filteredApps.length > 0 ? (
        <section aria-labelledby={headingId} className="flex flex-col gap-4">
          <h2
            className="font-heading text-xl font-medium tracking-tight text-balance"
            id={headingId}
          >
            {hasQuery ? "Results" : "All dApps"}
          </h2>
          <ul
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
            role="list"
          >
            {filteredApps.map((app) => (
              <li className="min-w-0" key={app.id}>
                <ExploreAppCard
                  app={app}
                  href={appDetailsPath(app.slug)}
                  status={appPresentationStatus(app.status).status}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div></div>
  )
}

export function Explore() {
  const [apps, setApps] = useState<AppRecord[] | null>(null)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState("")
  const [reloadToken, setReloadToken] = useState(0)

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

  return (
    <ExploreView
      apps={apps}
      error={error}
      onQueryChange={setQuery}
      onRetry={() => setReloadToken((current) => current + 1)}
      query={query}
    />
  )
}
