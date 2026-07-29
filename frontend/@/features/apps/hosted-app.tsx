import { ArrowLeft, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"

import { useDevConsoleFrame } from "@/hooks/use-dev-console-frame"
import { getApp, getIframeToken, type AppDetail } from "@/lib/apps-api"
import { resolveDevHost } from "@/lib/dev-host"
import { syncNativeTitle } from "@/lib/native-bridge"
import { appDetailsPath, appHash } from "@/lib/routes"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { PlatformIcon } from "@/components/platform-icon"
import { Skeleton } from "@/components/ui/skeleton"

const TOKEN_REFRESH_MS = 45 * 60 * 1000

function validInnerPath(value: string | null) {
  if (!value || value.length > 512 || !value.startsWith("/") || value.startsWith("//")) return null
  const hasUnsafeCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0)
    return /[\s\\`'"<>]/.test(character) || code < 32 || code === 127
  })
  return hasUnsafeCharacter ? null : value
}

function iframeSource(app: AppDetail, token: string | null, innerPath: string | null) {
  if (!app.url) return null
  try {
    const appUrl = resolveDevHost(app.url)
    const origin = new URL(appUrl).origin
    const source = new URL(innerPath || "/", appUrl)
    if (source.origin !== origin) return new URL(appUrl).toString()
    if (token) source.searchParams.set("token", token)
    return source.toString()
  } catch {
    return null
  }
}

function OfflineNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Alert className="max-w-md">
        <PlatformIcon icon={TriangleAlert} />
        <AlertTitle>This app needs a connection</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          Reconnect to open this child app.
          <Button onClick={onRetry} type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={RefreshCw} />Retry</Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}

function retryHostedApp() {
  window.location.reload()
}

export function HostedApp() {
  const { slug = "" } = useParams()
  const iframe = useRef<HTMLIFrameElement>(null)
  const [searchParams] = useSearchParams()
  const [app, setApp] = useState<AppDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [offline, setOffline] = useState(() => navigator.onLine === false)
  const [frameRevision, setFrameRevision] = useState(0)
  const innerPath = validInnerPath(searchParams.get("path"))

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
        setError(cause instanceof Error ? cause.message : "Unable to load app")
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [slug])

  useEffect(() => {
    const syncOffline = (event?: Event) => {
      const detail = event as CustomEvent<{ offline?: boolean }> | undefined
      setOffline(detail?.detail?.offline ?? navigator.onLine === false)
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
    if (!app?.url || app.status !== "running" || app.self_hosted) return
    let cancelled = false
    const refreshToken = async () => {
      try {
        const receivedToken = await getIframeToken()
        if (!cancelled) setToken(receivedToken)
      } catch {
        if (!cancelled) setError("Your app session could not be prepared.")
      }
    }
    void refreshToken()
    const interval = window.setInterval(() => void refreshToken(), TOKEN_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [app])

  const source = useMemo(() => app ? iframeSource(app, token, innerPath) : null, [app, token, innerPath])
  useDevConsoleFrame(slug, iframe, Boolean(source && !offline), frameRevision)
  if (error) return <div className="flex flex-1 items-center justify-center p-6"><Alert className="max-w-md" variant="destructive"><AlertTitle>App unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert></div>
  if (!app) return <div className="flex flex-1 p-4"><Skeleton className="h-full w-full" /></div>
  if (app.self_hosted) return <div className="flex flex-1 items-center justify-center p-6"><Alert className="max-w-md"><AlertTitle>{app.name} opens in Dev</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-3">This platform app has no child-app host.<Button render={<a aria-label={`Open ${app.name} in Dev`} href={appHash(app.slug, "dev")} />} variant="outline"><PlatformIcon data-icon="inline-start" icon={ExternalLink} />Open Dev</Button></AlertDescription></Alert></div>
  if (app.status !== "running" || !app.url) return <div className="flex flex-1 items-center justify-center p-6"><Alert className="max-w-md"><AlertTitle>App is not ready</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-3">Current status: {app.status.replaceAll("_", " ")}.<Button render={<Link to={appDetailsPath(app.slug)} />} variant="outline"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />App details</Button></AlertDescription></Alert></div>
  if (offline) return <OfflineNotice onRetry={retryHostedApp} />
  if (!token) return <div className="flex flex-1 p-4"><Skeleton className="h-full w-full" /></div>
  if (!source) return <div className="flex flex-1 items-center justify-center p-6"><Alert className="max-w-md" variant="destructive"><AlertTitle>Unsafe app destination</AlertTitle><AlertDescription>Return to the app details and try again.</AlertDescription></Alert></div>

  return (
    <div className="isolate flex min-h-0 flex-1 bg-background" data-testid="hosted-app">
      <h1 className="sr-only">{app.name}</h1>
      {/* This exact cross-origin iframe contract is shared with the legacy shell.
          allow-same-origin is required for child-app session and token behavior. */}
      <iframe
        allow="clipboard-write; pointer-lock"
        className="size-full border-0"
        data-testid="hosted-app-frame"
        onLoad={() => setFrameRevision((revision) => revision + 1)}
        ref={iframe}
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock"
        src={source}
        title={app.name}
      />
    </div>
  )
}
