import { ImageOff } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
import type { GalleryMedia, GalleryVisualCapture, GalleryVisuals } from "@/lib/gallery-api"

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

function MediaSurface({ media, side, capture }: { media?: GalleryMedia | null; side: "Before" | "After"; capture: GalleryVisualCapture }) {
  const webm = visualUrl(media?.webm)
  const still = visualUrl(media?.png) || visualUrl(media?.gif)
  const label = `${side} ${captureLabel(capture)}`
  if (!webm && !still) return <div className="flex aspect-video items-center justify-center rounded-[min(1vw,12px)] bg-muted px-4 text-center text-base/7 text-muted-foreground sm:text-sm/6">No {side.toLowerCase()} version to compare.</div>
  return <figure className="flex min-w-0 flex-col gap-2"><figcaption className="flex flex-wrap items-center gap-2 text-base/7 font-medium sm:text-sm/6">{side}{!webm ? <Badge variant="outline">No recording</Badge> : null}</figcaption>{webm ? <video aria-label={label} className="aspect-video w-full rounded-[min(1vw,12px)] bg-muted object-contain outline-1 -outline-offset-1 outline-foreground/10" controls loop muted playsInline poster={still || undefined} preload="none" src={webm} /> : <img alt={label} className="aspect-video w-full rounded-[min(1vw,12px)] bg-muted object-contain outline-1 -outline-offset-1 outline-foreground/10" loading="lazy" src={still!} />}</figure>
}

function CaptureGroup({ capture, showLabel }: { capture: GalleryVisualCapture; showLabel: boolean }) {
  const before = visualUrl(capture.before?.png) || visualUrl(capture.before?.webm) || visualUrl(capture.before?.gif)
  const after = visualUrl(capture.after?.png) || visualUrl(capture.after?.webm) || visualUrl(capture.after?.gif)
  const note = !after ? "No after artifact was stored for this capture." : !before ? "New page — no production version to compare." : capture.beforeFellBack ? '“Before” shows the home page because this screen did not exist in production yet.' : null
  return <section aria-label={`Visual comparison for ${captureLabel(capture)}`} className="flex flex-col gap-3">{showLabel ? <p className="font-mono text-base/7 text-muted-foreground sm:text-sm/6">Before / after · {captureLabel(capture)}</p> : null}<div className="grid gap-3 sm:grid-cols-2"><MediaSurface capture={capture} media={capture.before} side="Before" /><MediaSurface capture={capture} media={capture.after} side="After" /></div>{note ? <p className="text-base/7 text-muted-foreground sm:text-sm/6">{note}</p> : null}</section>
}

/**
 * Review evidence for stored proposal captures. This intentionally references
 * only validated, direct public `/visuals/:id` artifact URLs. It neither
 * proxies nor changes access to the already-public immutable bytes.
 */
export function GalleryVisualEvidence({ visuals }: { visuals: GalleryVisuals | undefined }) {
  const captures = visuals?.captures || []
  if (!captures.length) return <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center"><PlatformIcon icon={ImageOff} /><p className="text-base/7 font-medium sm:text-sm/6">No stored visual artifacts</p><p className="text-base/7 text-muted-foreground sm:text-sm/6">This outcome may not have produced screenshots or recordings.</p></div>
  return <div className="flex flex-col gap-5">{captures.map((capture, index) => <CaptureGroup capture={capture} key={capture.index} showLabel={captures.length > 1 || capture.path !== "/" || capture.viewport === "mobile" || index > 0} />)}</div>
}
