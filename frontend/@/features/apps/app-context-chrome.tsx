import { useNavigate } from "react-router-dom"

import { AppChrome, type AppChromeProps } from "@/features/apps/app-chrome"
import { appDevPath, appOpenPath } from "@/lib/routes"

type AppContextRootMode = {
  mode: "improve" | "use"
}

type AppContextNestedMode = {
  backTo: string
  label: string
  mode: "nested"
}

export type AppContextChromeProps = Pick<
  AppChromeProps,
  "app" | "consoleError" | "onOpenOverflow" | "onRetry" | "state"
> & (AppContextRootMode | AppContextNestedMode)

export function appContextState(app: AppChromeProps["app"]): AppChromeProps["state"] {
  if (app.self_hosted) return "self-hosted"
  return app.status === "running" ? "ready" : "unavailable"
}

/**
 * Routing adapter for the shared app-context chrome. It keeps AppChrome
 * props-only while giving every React app route the same reciprocal mode and
 * Home exit semantics. Nested routes must name their context and destination
 * instead of approximating browser history.
 */
export function AppContextChrome(props: AppContextChromeProps) {
  const navigate = useNavigate()
  const nested = props.mode === "nested"

  return (
    <div className="relative isolate w-full" data-testid="app-context-chrome">
      <AppChrome
        app={props.app}
        consoleError={props.consoleError}
        mode={props.mode}
        nestedLabel={nested ? props.label : undefined}
        onBack={nested ? () => navigate(props.backTo) : undefined}
        onClose={() => navigate("/", { replace: true })}
        onImprove={props.mode === "use" ? () => navigate(appDevPath(props.app.slug)) : undefined}
        onOpenOverflow={props.onOpenOverflow}
        onRetry={props.onRetry}
        onUse={props.mode === "improve" ? () => navigate(appOpenPath(props.app.slug)) : undefined}
        placement="flow"
        state={props.state}
      />
    </div>
  )
}
