import { Images } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { DevVisuals } from "@/lib/dev-chat-api"

function visualSource(media: { png?: string; gif?: string } | null) {
  const id = media?.png || media?.gif
  return id && /^[a-f0-9]{32}$/.test(id) ? `/visuals/${id}` : null
}

/** Immutable server-captured review evidence. This does not start a preview or rebuild. */
export function DevVisualEvidence({ visuals }: { visuals: DevVisuals | null | undefined }) {
  if (!visuals?.captures?.length) return null
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><PlatformIcon icon={Images} size="sm" />Before and after</CardTitle><CardDescription>Captured review evidence for the latest staging change.</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">
    {visuals.captures.map((capture) => {
      const before = visualSource(capture.before)
      const after = visualSource(capture.after)
      if (!after) return null
      const label = `${capture.path}${capture.viewport === "mobile" ? " · mobile" : ""}`
      return <section aria-label={`Visual comparison for ${label}`} className="flex flex-col gap-2" key={capture.index}>
        <p className="text-sm font-medium">{label}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <figure className="flex flex-col gap-2"><figcaption className="text-sm text-muted-foreground">Before</figcaption>{before ? <img alt={`Before ${label}`} className="rounded-lg border" loading="lazy" src={before} /> : <p className="text-sm text-muted-foreground">No production capture for this route.</p>}</figure>
          <figure className="flex flex-col gap-2"><figcaption className="text-sm text-muted-foreground">After</figcaption><img alt={`After ${label}`} className="rounded-lg border" loading="lazy" src={after} /></figure>
        </div>
        {capture.beforeFellBack ? <p className="text-sm text-muted-foreground">The production capture used the home route because this screen did not exist there yet.</p> : null}
      </section>
    })}
  </CardContent></Card>
}
