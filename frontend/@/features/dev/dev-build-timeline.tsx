import { ChevronRight, Hammer, Timer } from "lucide-react"
import { useMemo } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { DevSessionMessage } from "@/lib/dev-chat-api"

export type BuildSegment = { id: number; label: string; lines: string[]; active?: boolean }
function strings(value: unknown) { return Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : [] }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value : null }

/** Safe normalizer for existing owner-scoped persisted session metadata. */
export function buildSegments(messages: DevSessionMessage[], liveLines: string[] = []): BuildSegment[] {
  const segments = messages.flatMap((message) => {
    if (message.role !== "system" || !message.metadata || typeof message.metadata !== "object") return []
    const metadata = message.metadata
    const progress = strings(metadata.progressLog); const output = text(metadata.ccOutput); const log = text(metadata.ccLog)
    const result: BuildSegment[] = []
    if (progress.length) result.push({ id: message.id, label: message.content || "Claude Code progress", lines: progress })
    if (output) result.push({ id: message.id * 1000 + 1, label: message.content || "Claude Code result", lines: output.split("\n") })
    if (log) result.push({ id: message.id * 1000 + 2, label: "Claude Code log", lines: log.split("\n") })
    return result
  })
  if (liveLines.length) segments.push({ id: -1, label: "Active build", lines: liveLines, active: true })
  return segments
}

export function DevBuildTimeline({ estimate, liveLines = [], messages }: { estimate?: string | null; liveLines?: string[]; messages: DevSessionMessage[] }) {
  const segments = useMemo(() => buildSegments(messages, liveLines), [liveLines, messages])
  if (!segments.length && !estimate) return null
  return <Card data-testid="dev-build-timeline"><CardHeader><CardTitle className="flex items-center gap-2"><PlatformIcon icon={Hammer} size="sm" />Build timeline</CardTitle>{estimate ? <Badge variant="secondary"><PlatformIcon data-icon="inline-start" icon={Timer} />{estimate}</Badge> : null}</CardHeader><CardContent className="space-y-2">{segments.map((segment) => <details className="rounded-md border" key={segment.id} open={segment.active}><summary className="flex cursor-pointer items-center gap-2 p-3 text-sm font-medium"><PlatformIcon icon={ChevronRight} size="xs" />{segment.label}<span className="ml-auto text-xs text-muted-foreground">{segment.lines.length} lines</span></summary><pre className="max-h-72 overflow-auto border-t bg-muted p-3 text-xs whitespace-pre-wrap">{segment.lines.join("\n")}</pre></details>)}</CardContent></Card>
}
