import { ArrowLeft, MoreHorizontal, RefreshCw, X } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { StatusDot, type StatusDotRole } from "@/components/status-dot"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { AppIdentity } from "@/features/apps/app-identity"
import type { AppDetail } from "@/lib/apps-api"

export type AppChromeProps = {
  app: AppDetail
  mode: "use" | "improve" | "nested"
  state: "loading" | "ready" | "offline" | "unavailable" | "self-hosted"
  onClose: () => void
  onBack?: () => void
  onImprove?: () => void
  onRetry?: () => void
  onUse?: () => void
  onOpenOverflow?: () => void
  consoleError?: boolean
  nestedLabel?: string
}

const statePresentation = {
  loading: { label: "Preparing", role: "neutral" },
  ready: { label: "Running", role: "positive" },
  offline: { label: "Offline", role: "attention" },
  unavailable: { label: "Unavailable", role: "negative" },
  "self-hosted": { label: "Self-hosted", role: "info" },
} satisfies Record<AppChromeProps["state"], { label: string; role: StatusDotRole }>

/**
 * Compact focused-app controls. The absolute overlay does not reserve iframe
 * space, and all domain decisions remain with the host adapter.
 */
export function AppChrome({
  app,
  consoleError = false,
  mode,
  nestedLabel,
  onBack,
  onClose,
  onImprove,
  onOpenOverflow,
  onRetry,
  onUse,
  state,
}: AppChromeProps) {
  const status = statePresentation[state]

  return (
    <Card
      aria-label={`${app.name} controls`}
      className="absolute inset-x-3 top-3 z-10 min-h-12 flex-row flex-wrap items-center gap-2 p-2"
      data-state={state}
      role="group"
    >
      {mode === "nested" && onBack ? (
        <Button
          aria-label="Back"
          className="size-12"
          onClick={onBack}
          title="Back"
          type="button"
          variant="ghost"
        >
          <PlatformIcon icon={ArrowLeft} />
        </Button>
      ) : null}
      <AppIdentity app={app} size="sm" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-medium">
          {app.name}
          {nestedLabel ? <span className="text-muted-foreground"> · {nestedLabel}</span> : null}
        </h1>
        <StatusDot
          className="text-xs text-muted-foreground"
          label={status.label}
          role={status.role}
          size="sm"
          subject={app.name}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {state === "offline" && onRetry ? (
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            <PlatformIcon data-icon="inline-start" icon={RefreshCw} />
            Retry
          </Button>
        ) : null}
        {mode === "use" && onImprove && (state === "ready" || state === "self-hosted") ? (
          <Button onClick={onImprove} size="sm" type="button" variant="outline">
            Improve
          </Button>
        ) : null}
        {mode === "improve" && onUse && (state === "ready" || state === "self-hosted") ? (
          <Button onClick={onUse} size="sm" type="button" variant="outline">
            Use
          </Button>
        ) : null}
        {onOpenOverflow ? (
          <Button
            aria-label={consoleError ? "App actions, developer console has errors" : "App actions"}
            className="relative size-12"
            onClick={onOpenOverflow}
            title="App actions"
            type="button"
            variant="ghost"
          >
            <PlatformIcon icon={MoreHorizontal} />
            {consoleError ? (
              <StatusDot
                className="absolute top-1.5 right-1.5"
                label="Errors"
                role="negative"
                showLabel={false}
                size="sm"
                subject={`${app.name} developer console`}
              />
            ) : null}
          </Button>
        ) : null}
        <Button
          aria-label={`Close ${app.name}`}
          className="size-12"
          onClick={onClose}
          title={`Close ${app.name}`}
          type="button"
          variant="ghost"
        >
          <PlatformIcon icon={X} />
        </Button>
      </div>
    </Card>
  )
}
