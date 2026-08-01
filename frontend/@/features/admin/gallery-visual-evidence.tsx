import { CircleX, ImageOff, RotateCcw } from "lucide-react"
import { useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { gallerySurfaceKey, type GallerySurfaceReadiness } from "@/features/admin/gallery-media-readiness"
import type { GalleryMedia, GalleryVisualCapture, GalleryVisuals } from "@/lib/gallery-api"
import { cn } from "@/lib/utils"

type SourceMode = "image" | "invalid" | "video"

function visualId(value?: string | null) {
  return value && /^[a-f0-9]{32}$/.test(value) ? value : null
}

function visualUrl(value?: string | null) {
  const id = visualId(value)
  return id ? `/visuals/${id}` : null
}

function captureLabel(capture: GalleryVisualCapture) {
  const path = capture.path || "/"
  return `${path}${capture.viewport === "mobile" ? " · mobile" : ""}`
}

function declaredReference(media?: GalleryMedia | null) {
  return Boolean(media?.webm || media?.png || media?.gif)
}

function retryUrl(url: string, attempt: number) {
  return attempt ? `${url}?retry=${attempt}` : url
}

function MediaSurface({ media, side, capture, onReadinessChange, surfaceId }: { media?: GalleryMedia | null; side: "Before" | "After"; capture: GalleryVisualCapture; onReadinessChange?: (surfaceId: string, readiness: GallerySurfaceReadiness) => void; surfaceId: string | null }) {
  const webm = visualUrl(media?.webm)
  const still = visualUrl(media?.png) || visualUrl(media?.gif)
  const label = `${side} ${captureLabel(capture)}`
  const initialMode: SourceMode = webm ? "video" : still ? "image" : "invalid"
  const [attempt, setAttempt] = useState(0)
  const [mode, setMode] = useState<SourceMode>(initialMode)
  const [readiness, setReadiness] = useState<GallerySurfaceReadiness>(initialMode === "invalid" ? "error" : "loading")
  const [fellBack, setFellBack] = useState(false)

  if (!declaredReference(media)) return <div className="flex aspect-video items-center justify-center rounded-[min(1vw,12px)] bg-muted px-4 text-center text-base/7 text-muted-foreground sm:text-sm/6">No {side.toLowerCase()} version to compare.</div>

  function report(next: GallerySurfaceReadiness) {
    setReadiness(next)
    if (surfaceId) onReadinessChange?.(surfaceId, next)
  }

  function fail() {
    if (mode === "video" && still) {
      setFellBack(true)
      setMode("image")
      report("loading")
      return
    }
    report("error")
  }

  function retry() {
    setAttempt((current) => current + 1)
    setFellBack(false)
    setMode(initialMode)
    report(initialMode === "invalid" ? "error" : "loading")
  }

  const source = mode === "video" ? webm : mode === "image" ? still : null
  return (
    <figure className="flex min-w-0 flex-col gap-2" data-media-readiness={readiness}>
      <figcaption className="flex flex-wrap items-center gap-2 text-base/7 font-medium sm:text-sm/6">
        {side}
        {!webm ? <Badge variant="outline">No recording</Badge> : null}
        {fellBack ? <Badge variant="outline">Recording unavailable</Badge> : null}
      </figcaption>
      <div aria-busy={readiness === "loading"} className="relative aspect-video overflow-hidden rounded-[min(1vw,12px)] bg-muted">
        {readiness === "loading" ? (
          <div className="absolute inset-0" role="status">
            <Skeleton className="size-full rounded-none" />
            <span className="sr-only">Loading {label.toLowerCase()}</span>
          </div>
        ) : null}
        {readiness === "error" ? (
          <div className="flex size-full items-center justify-center p-3">
            <Alert className="pr-4 sm:pr-18" tone="negative">
              <PlatformIcon icon={CircleX} />
              <AlertTitle>{side} visual didn’t load</AlertTitle>
              <AlertDescription>{source ? "The stored media could not be opened." : "The stored artifact reference is invalid."}</AlertDescription>
              {source ? <AlertAction className="static col-span-full mt-2 justify-self-start sm:absolute sm:mt-0"><Button onClick={retry} size="sm" type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={RotateCcw} />Retry</Button></AlertAction> : null}
            </Alert>
          </div>
        ) : null}
        {source && readiness !== "error" ? mode === "video" ? (
          <video
            aria-label={label}
            className={cn("size-full object-contain outline-1 -outline-offset-1 outline-foreground/10 transition-opacity", readiness === "ready" ? "opacity-100" : "opacity-0")}
            controls={readiness === "ready"}
            key={`${source}-${attempt}`}
            loop
            muted
            onError={fail}
            onLoadedData={() => report("ready")}
            playsInline
            poster={still || undefined}
            preload="auto"
            src={retryUrl(source, attempt)}
          />
        ) : (
          <img
            alt={label}
            className={cn("size-full object-contain outline-1 -outline-offset-1 outline-foreground/10 transition-opacity", readiness === "ready" ? "opacity-100" : "opacity-0")}
            key={`${source}-${attempt}`}
            loading="lazy"
            onError={fail}
            onLoad={() => report("ready")}
            src={retryUrl(source, attempt)}
          />
        ) : null}
      </div>
    </figure>
  )
}

function CaptureGroup({ capture, onSurfaceReadinessChange, showLabel }: { capture: GalleryVisualCapture; onSurfaceReadinessChange?: (key: string, readiness: GallerySurfaceReadiness) => void; showLabel: boolean }) {
  const before = visualUrl(capture.before?.png) || visualUrl(capture.before?.webm) || visualUrl(capture.before?.gif)
  const after = visualUrl(capture.after?.png) || visualUrl(capture.after?.webm) || visualUrl(capture.after?.gif)
  const note = !after ? "No after artifact was stored for this capture." : !before ? "New page — no production version to compare." : capture.beforeFellBack ? '“Before” shows the home page because this screen did not exist in production yet.' : null
  const beforeKey = gallerySurfaceKey(capture, "Before", capture.before)
  const afterKey = gallerySurfaceKey(capture, "After", capture.after)
  return <section aria-label={`Visual comparison for ${captureLabel(capture)}`} className="flex flex-col gap-3">{showLabel ? <p className="font-mono text-base/7 text-muted-foreground sm:text-sm/6">Before / after · {captureLabel(capture)}</p> : null}<div className="grid gap-3 sm:grid-cols-2"><MediaSurface capture={capture} key={beforeKey || "before-empty"} media={capture.before} onReadinessChange={onSurfaceReadinessChange} side="Before" surfaceId={beforeKey} /><MediaSurface capture={capture} key={afterKey || "after-empty"} media={capture.after} onReadinessChange={onSurfaceReadinessChange} side="After" surfaceId={afterKey} /></div>{note ? <p className="text-base/7 text-muted-foreground sm:text-sm/6">{note}</p> : null}</section>
}

/**
 * Review evidence for stored proposal captures. This intentionally references
 * only validated, direct public `/visuals/:id` artifact URLs. It neither
 * proxies nor changes access to the already-public immutable bytes.
 */
export function GalleryVisualEvidence({ onSurfaceReadinessChange, visuals }: { onSurfaceReadinessChange?: (surfaceId: string, readiness: GallerySurfaceReadiness) => void; visuals: GalleryVisuals | undefined }) {
  const captures = visuals?.captures || []
  if (!captures.length) return <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center"><PlatformIcon icon={ImageOff} /><p className="text-base/7 font-medium sm:text-sm/6">No stored visual artifacts</p><p className="text-base/7 text-muted-foreground sm:text-sm/6">This outcome may not have produced screenshots or recordings.</p></div>
  return <div className="flex flex-col gap-5">{captures.map((capture, index) => <CaptureGroup capture={capture} key={capture.index} onSurfaceReadinessChange={onSurfaceReadinessChange} showLabel={captures.length > 1 || capture.path !== "/" || capture.viewport === "mobile" || index > 0} />)}</div>
}
