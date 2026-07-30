import { useEffect, useState } from "react"
import { useParams, useSearchParams } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { AppTopBar } from "@/features/apps/app-top-bar"
import { FocusedAppFrame } from "@/features/apps/focused-app-frame"
import { getApp, getIframeToken, type AppDetail } from "@/lib/apps-api"
import { useDevConsoleContext } from "@/lib/dev-console-context"
import { syncNativeTitle } from "@/lib/native-bridge"
import { safeAppInnerPath } from "@/lib/routes"

const TOKEN_REFRESH_MS = 45 * 60 * 1000

function retryHostedApp() {
  window.location.reload()
}

export function HostedApp() {
  const { slug = "" } = useParams()
  const [searchParams] = useSearchParams()
  const [app, setApp] = useState<AppDetail | null>(null)
  const [loadErrorState, setLoadErrorState] = useState<{ slug: string; message: string } | null>(null)
  const [tokenErrorState, setTokenErrorState] = useState<{ slug: string; message: string } | null>(null)
  const [tokenState, setTokenState] = useState<{ slug: string; value: string } | null>(null)
  const [offline, setOffline] = useState(() => navigator.onLine === false)
  const devConsole = useDevConsoleContext()
  const innerPath = safeAppInnerPath(searchParams.get("path"))
  const currentApp = app?.slug === slug ? app : null
  const loadError = loadErrorState?.slug === slug ? loadErrorState.message : null
  const token = tokenState?.slug === slug ? tokenState.value : null
  const tokenError = tokenErrorState?.slug === slug ? tokenErrorState.message : null

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    getApp(slug, controller.signal)
      .then(({ app: receivedApp }) => {
        if (cancelled) return
        setApp(receivedApp)
        syncNativeTitle(receivedApp.name)
      })
      .catch((cause: unknown) => {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        setLoadErrorState({
          slug,
          message: cause instanceof Error ? cause.message : "Unable to load app",
        })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [slug])

  useEffect(() => {
    const syncOffline = (event?: Event) => {
      const detail = event as CustomEvent<{ offline?: boolean }> | undefined
      const nextOffline = detail?.detail?.offline ?? navigator.onLine === false
      setOffline(nextOffline)
    }
    window.addEventListener("online", syncOffline)
    window.addEventListener("offline", syncOffline)
    window.addEventListener("usernode:offline-change", syncOffline)
    return () => {
      window.removeEventListener("online", syncOffline)
      window.removeEventListener("offline", syncOffline)
      window.removeEventListener("usernode:offline-change", syncOffline)
    }
  }, [])

  useEffect(() => {
    if (!currentApp?.url || currentApp.status !== "running" || currentApp.self_hosted) return
    const controller = new AbortController()
    let cancelled = false
    const refreshToken = async () => {
      try {
        const receivedToken = await getIframeToken(currentApp.slug, controller.signal)
        if (cancelled) return
        setTokenErrorState(null)
        setTokenState({ slug: currentApp.slug, value: receivedToken })
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        setTokenErrorState({
          slug: currentApp.slug,
          message: cause instanceof Error ? cause.message : "Your app session could not be prepared.",
        })
      }
    }
    void refreshToken()
    const interval = window.setInterval(() => void refreshToken(), TOKEN_REFRESH_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(interval)
    }
  }, [currentApp])

  if (loadError) {
    return (
      <>
        <AppTopBar app={currentApp} consoleError={devConsole.unseenErrors > 0} fallbackTitle={loadError ? "App unavailable" : "Loading app"} mode="use" onOpenOverflow={devConsole.visible ? () => devConsole.setOpen(true) : undefined} />
        <div className="flex flex-1 items-center justify-center" data-slot="hosted-app-surface" data-state="error">
          <Alert className="max-w-md" variant="destructive">
            <AlertTitle>App unavailable</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        </div>
      </>
    )
  }

  if (!currentApp) {
    return (
      <>
        <AppTopBar app={currentApp} consoleError={devConsole.unseenErrors > 0} fallbackTitle={loadError ? "App unavailable" : "Loading app"} mode="use" onOpenOverflow={devConsole.visible ? () => devConsole.setOpen(true) : undefined} />
        <div className="flex flex-1" data-slot="hosted-app-surface" data-state="loading">
          <Skeleton className="h-full w-full" />
        </div>
      </>
    )
  }

  return (
    <div className="isolate flex min-h-0 flex-1 flex-col bg-background" data-slot="hosted-app-surface" data-state="ready" data-testid="hosted-app">
      {/* The app owns the whole page; the bar floats over it so no viewport
          estate is spent on chrome. */}
      <AppTopBar app={currentApp} consoleError={devConsole.unseenErrors > 0} fallbackTitle={loadError ? "App unavailable" : "Loading app"} mode="use" onOpenOverflow={devConsole.visible ? () => devConsole.setOpen(true) : undefined} placement="overlay" />

      {tokenError ? (
        <div className="flex flex-1 items-center justify-center" data-slot="focused-app-surface" data-state="error">
          <Alert className="max-w-md" variant="destructive">
            <AlertTitle>App unavailable</AlertTitle>
            <AlertDescription>{tokenError}</AlertDescription>
          </Alert>
        </div>
      ) : (
        <FocusedAppFrame
          app={currentApp}
          iframeToken={token}
          innerPath={innerPath}
          offline={offline}
          onRetry={retryHostedApp}
        />
      )}
    </div>
  )
}
