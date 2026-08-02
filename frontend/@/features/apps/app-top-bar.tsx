import { MoreHorizontal, X } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { StatusDot } from "@/components/status-dot"
import { TopBar } from "@/components/top-bar"
import { Button } from "@/components/ui/button"
import type { AppDetail } from "@/lib/apps-api"
import { appDevPath, appOpenPath } from "@/lib/routes"

type AppTopBarMode =
  | { mode: "improve" | "use" }
  | { backTo: string; label: string; mode: "nested" }

export type AppTopBarProps = {
  /** Null while the app is still loading or failed to load. */
  app: AppDetail | null
  /** Screen name to use until the app resolves. */
  fallbackTitle?: string
  consoleError?: boolean
  onOpenOverflow?: () => void
  showClose?: boolean
} & AppTopBarMode

/**
 * Routing adapter between an app route and the shared TopBar. It owns the
 * reciprocal Use/Improve semantics, Home exit, nested destinations, and the
 * `App · Context` title composition — everything the removed AppContextChrome
 * did, minus a second bar. App status is presented by FocusedAppFrame.
 */
export function AppTopBar(props: AppTopBarProps) {
  const {
    app,
    consoleError = false,
    fallbackTitle = "App",
    onOpenOverflow,
    showClose = true,
  } = props
  const navigate = useNavigate()

  // Before the app resolves there is no identity, mode, or exit to offer —
  // the drawer remains the escape route.
  if (!app) return <TopBar title={fallbackTitle} />

  const nested = props.mode === "nested"
  const label = nested ? props.label : ""
  // Contribution entry stays hidden until the app is presentable and the
  // session is allowed to collaborate.
  const presentable = Boolean(app.self_hosted) || app.status === "running"

  return (
    <TopBar
      action={
        <>
          {props.mode === "use" && presentable && app.can_collaborate !== false ? (
            <Button
              onClick={() => navigate(appDevPath(app.slug))}
              size="sm"
              type="button"
              variant="outline"
            >
              Improve
            </Button>
          ) : null}
          {props.mode === "improve" && presentable ? (
            <Button
              onClick={() => navigate(appOpenPath(app.slug))}
              size="sm"
              type="button"
              variant="outline"
            >
              Use
            </Button>
          ) : null}
          {onOpenOverflow ? (
            <Button
              aria-label={
                consoleError
                  ? "Open developer console, errors"
                  : "Open developer console"
              }
              className="relative size-12"
              onClick={onOpenOverflow}
              title="Developer console"
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
          {showClose ? (
            <Button
              aria-label={`Close ${app.name}`}
              className="size-12"
              onClick={() => navigate("/", { replace: true })}
              title={`Close ${app.name}`}
              type="button"
              variant="ghost"
            >
              <PlatformIcon icon={X} />
            </Button>
          ) : null}
        </>
      }
      onBack={nested ? () => navigate(props.backTo) : undefined}
      title={label ? `${app.name} · ${label}` : app.name}
    />
  )
}
