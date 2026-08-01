import { Activity, GitMerge, RefreshCw } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
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
  return <div className="status-surface flex flex-col gap-2 rounded-xl border p-4" data-status-tone="info" data-testid="dev-session-activity">
    <div className="flex items-center justify-between gap-3 text-sm font-medium"><span className="flex items-center gap-2"><PlatformIcon icon={icon} size="sm" />Current activity</span><Badge variant="secondary">In progress</Badge></div>
    <p className="text-sm text-current/80">{progressText(status)}</p>
  </div>
}
