import { useCallback, useEffect, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"

import { PlatformMenuTrigger } from "@/components/platform-shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { AppChrome, type AppChromeProps } from "@/features/apps/app-chrome"
import { FocusedAppFrame } from "@/features/apps/focused-app-frame"
import { getApp, getIframeToken, type AppDetail } from "@/lib/apps-api"
import { useDevConsoleContext } from "@/lib/dev-console-context"
import { syncNativeTitle } from "@/lib/native-bridge"
import { appDevPath, safeAppInnerPath } from "@/lib/routes"

const TOKEN_REFRESH_MS = 45 * 60 * 1000

function chromeState({
  app,
  frameLoaded,
  offline,
  token,
  tokenError,
}: {
  app: AppDetail
  frameLoaded: boolean
  offline: boolean
  token: string | null
  tokenError: string | null
}): AppChromeProps["state"] {
  if (app.self_hosted) return "self-hosted"
  if (offline) return "offline"
  if (app.status !== "running" || !app.url || tokenError) return "unavailable"
  return token && frameLoaded ? "ready" : "loading"
}

function retryHostedApp() {
  window.location.reload()
}

export function HostedApp() {
  const { slug = "" } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [app, setApp] = useState<AppDetail | null>(null)
  const [loadErrorState, setLoadErrorState] = useState<{ slug: string; message: string } | null>(null)
  const [tokenErrorState, setTokenErrorState] = useState<{ slug: string; message: string } | null>(null)
  const [tokenState, setTokenState] = useState<{ slug: string; value: string } | null>(null)
  const [offline, setOffline] = useState(() => navigator.onLine === false)
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null)
  const devConsole = useDevConsoleContext()
  const innerPath = safeAppInnerPath(searchParams.get("path"))
  const currentApp = app?.slug === slug ? app : null
  const loadError = loadErrorState?.slug === slug ? loadErrorState.message : null
  const token = tokenState?.slug === slug ? tokenState.value : null
  const tokenError = tokenErrorState?.slug === slug ? tokenErrorState.message : null
  const frameKey = currentApp && token
    ? `${currentApp.id}:${currentApp.url || ""}:${innerPath || "/"}:${token}`
    : null
  const frameLoaded = Boolean(frameKey && loadedFrameKey === frameKey)

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
      if (nextOffline) setLoadedFrameKey(null)
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
        setLoadedFrameKey(null)
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

  const closeApp = useCallback(() => {
    navigate("/", { replace: true })
  }, [navigate])

  const improveApp = useCallback(() => {
    if (currentApp) navigate(appDevPath(currentApp.slug))
  }, [currentApp, navigate])

  const handleFrameLoad = useCallback(() => {
    setLoadedFrameKey(frameKey)
  }, [frameKey])

  if (loadError) {
    return (
      <div className="flex flex-1 items-center justify-center" data-slot="hosted-app-surface" data-state="error">
        <Alert className="max-w-md" variant="destructive">
          <AlertTitle>App unavailable</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!currentApp) {
    return (
      <div className="flex flex-1" data-slot="hosted-app-surface" data-state="loading">
        <Skeleton className="h-full w-full" />
      </div>
    )
  }

  const state = chromeState({
    app: currentApp,
    frameLoaded,
    offline,
    token,
    tokenError,
  })

  return (
    <div className="isolate flex min-h-0 flex-1 flex-col bg-background" data-slot="hosted-app-surface" data-state="ready" data-testid="hosted-app">
      <AppChrome
        app={currentApp}
        consoleError={devConsole.unseenErrors > 0}
        menuSlot={<PlatformMenuTrigger />}
        mode="use"
        onClose={closeApp}
        onImprove={currentApp.can_collaborate !== false ? improveApp : undefined}
        onOpenOverflow={devConsole.visible ? () => devConsole.setOpen(true) : undefined}
        placement="flow"
        state={state}
      />

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
          onFrameLoad={handleFrameLoad}
          onRetry={retryHostedApp}
        />
      )}
    </div>
  )
}
