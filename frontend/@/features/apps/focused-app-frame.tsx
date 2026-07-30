import { useMemo, useRef, useState } from "react"

import { useDevConsoleFrame } from "@/hooks/use-dev-console-frame"
import { appPresentationStatus } from "@/features/apps/app-presentation-status"
import type { AppDetail } from "@/lib/apps-api"
import { resolveDevHost } from "@/lib/dev-host"
import { safeAppInnerPath } from "@/lib/routes"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

export type FocusedAppFrameProps = {
  app: AppDetail
  innerPath: string | null
  iframeToken: string | null
  offline: boolean
  onRetry: () => void
}

const frameAllow = "clipboard-write; pointer-lock"
const frameSandbox = "allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock"

function frameSource(app: AppDetail, token: string, innerPath: string | null) {
  if (!app.url) return null
  try {
    const appUrl = resolveDevHost(app.url)
    const origin = new URL(appUrl).origin
    const source = new URL(safeAppInnerPath(innerPath) || "/", appUrl)
    if (source.origin !== origin) return new URL(appUrl).toString()
    source.searchParams.set("token", token)
    return source.toString()
  } catch {
    return null
  }
}

function FrameMessage({
  children,
  state,
  title,
  variant,
}: {
  children?: React.ReactNode
  state: "offline" | "self-hosted" | "unavailable" | "error"
  title: string
  variant?: "default" | "destructive"
}) {
  return (
    <div className="flex flex-1 items-center justify-center" data-slot="focused-app-surface" data-state={state}>
      <Alert className="max-w-md" variant={variant}>
        <AlertTitle>{title}</AlertTitle>
        {children ? <AlertDescription>{children}</AlertDescription> : null}
      </Alert>
    </div>
  )
}

/**
 * Contract-heavy child-app host. The orchestration adapter owns fetching and
 * token cadence; this component owns frame source validation, permissions,
 * registration, and load handoff without adding presentation-only remounts.
 */
export function FocusedAppFrame({
  app,
  iframeToken,
  innerPath,
  offline,
  onRetry,
}: FocusedAppFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [frameRevision, setFrameRevision] = useState(0)
  const source = useMemo(
    () => (iframeToken ? frameSource(app, iframeToken, innerPath) : null),
    [app, iframeToken, innerPath]
  )
  const canHost = Boolean(
    !app.self_hosted &&
    app.status === "running" &&
    app.url &&
    iframeToken &&
    source &&
    !offline
  )

  useDevConsoleFrame(app.slug, frame, canHost, frameRevision)

  if (app.self_hosted) {
    return (
      <FrameMessage state="self-hosted" title={`${app.name} opens in Dev`}>
        Use Dev to work on this app.
      </FrameMessage>
    )
  }

  if (app.status !== "running" || !app.url) {
    const status = appPresentationStatus(app.status)
    return (
      <FrameMessage state="unavailable" title="App isn't ready">
        {status.label}
      </FrameMessage>
    )
  }

  if (offline) {
    return (
      <FrameMessage state="offline" title="Connection needed">
        <span className="flex flex-wrap items-center gap-3">
          Reconnect, then try again.
          <Button onClick={onRetry} type="button" variant="outline">Retry</Button>
        </span>
      </FrameMessage>
    )
  }

  if (!iframeToken) {
    return (
      <div
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-3"
        data-slot="focused-app-surface"
        data-state="loading"
        role="status"
      >
        <span className="text-base text-muted-foreground sm:text-sm">Preparing {app.name}…</span>
        <Skeleton aria-hidden="true" className="min-h-64 flex-1" />
      </div>
    )
  }

  if (!source) {
    return (
      <FrameMessage state="error" title="App can't open" variant="destructive">
        Open app details and try again.
      </FrameMessage>
    )
  }

  return (
    <div className="isolate flex min-h-0 flex-1 bg-background" data-slot="focused-app-surface" data-state="ready" data-testid="focused-app">
      <iframe
        allow={frameAllow}
        className="size-full border-0"
        data-testid="focused-app-frame"
        onLoad={() => setFrameRevision((revision) => revision + 1)}
        ref={frame}
        sandbox={frameSandbox}
        src={source}
        title={app.name}
      />
    </div>
  )
}
