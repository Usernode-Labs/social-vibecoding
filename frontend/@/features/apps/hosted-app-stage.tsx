import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export type HostedAppStageState =
  | "error"
  | "loading"
  | "provisioning"
  | "ready"
  | "rebuilding"

export type HostedAppStageProps = {
  children: ReactNode
  header: ReactNode
  loadingGutter?: "default" | "roomy"
  staged?: boolean
  state: HostedAppStageState
  testId?: string
}

/**
 * Platform-owned surround for one hosted application state. Route adapters
 * retain data, navigation and iframe behavior; the stage owns only the stable
 * chrome-to-app boundary and its responsive geometry.
 */
export function HostedAppStage({
  children,
  header,
  loadingGutter = "default",
  staged = false,
  state,
  testId,
}: HostedAppStageProps) {
  const visualState = state === "ready" ? "ready" : state === "error" ? "error" : "loading"

  return (
    <div
      className="isolate flex min-h-0 flex-1 flex-col text-foreground"
      data-slot="hosted-app-stage"
      data-state={state}
      data-surface="print"
      data-testid={testId}
    >
      {header}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          staged ? "status-surface p-1 sm:p-2" : "p-0 sm:p-2"
        )}
        data-slot="app-stage-boundary"
        data-status-tone={staged ? "info" : undefined}
      >
        {staged ? (
          <div className="flex min-h-8 shrink-0 items-center gap-2 px-2" data-slot="app-stage-status">
            <Badge className="border-current/30 text-current" variant="outline">Staged</Badge>
            <span className="text-xs text-current/80">Review environment</span>
          </div>
        ) : null}
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-xl bg-stage text-stage-foreground sm:rounded-xl"
          data-slot="app-stage-card"
          data-loading-gutter={loadingGutter}
          data-state={visualState}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
