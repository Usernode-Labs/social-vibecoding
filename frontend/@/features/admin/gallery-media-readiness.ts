import type { GalleryMedia, GalleryVisualCapture, GalleryVisuals } from "@/lib/gallery-api"

export type GallerySurfaceReadiness = "error" | "loading" | "ready"

export function gallerySurfaceKey(capture: GalleryVisualCapture, side: "Before" | "After", media?: GalleryMedia | null) {
  if (!media?.webm && !media?.png && !media?.gif) return null
  return [capture.index, side, media.webm || "", media.png || "", media.gif || ""].join(":")
}

export function gallerySurfaceKeys(visuals: GalleryVisuals | undefined) {
  const keys: string[] = []
  for (const capture of visuals?.captures || []) {
    const before = gallerySurfaceKey(capture, "Before", capture.before)
    const after = gallerySurfaceKey(capture, "After", capture.after)
    if (before) keys.push(before)
    if (after) keys.push(after)
  }
  return keys
}
