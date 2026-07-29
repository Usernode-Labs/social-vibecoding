import { Activity, GitMerge, RefreshCw } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { DevSessionStatus } from "@/lib/dev-chat-api"

function progressText(status: DevSessionStatus) {
  const latest = status.progress.at(-1)
  if (typeof latest === "string") return latest
  if (latest?.text) return latest.text
  if (status.resolving) return "Resolving merge conflicts"
  if (status.sync) return "Syncing with main"
  if (status.estimate?.text) return status.estimate.text
  return status.busy ? "Builder is working" : "Builder is ready"
}

/** Activity summary; the session route owns the guarded stop-turn action. */
export function DevSessionActivity({ status }: { status: DevSessionStatus | null }) {
  if (!status?.busy && !status?.resolving && !status?.sync) return null
  const icon = status.resolving ? GitMerge : status.sync ? RefreshCw : Activity
  return <Card size="sm"><CardHeader><CardTitle className="flex items-center gap-2"><PlatformIcon icon={icon} size="sm" />Current Dev activity</CardTitle><Badge variant="secondary">In progress</Badge><CardDescription>{progressText(status)}</CardDescription></CardHeader><CardContent className="text-sm text-muted-foreground">The session stream is live below. Merge and recovery controls remain available in legacy Dev.</CardContent></Card>
}
