import { TerminalSquare, Trash2 } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type DevConsoleLevel = "error" | "warn" | "info" | "log" | "debug"
export type DevConsoleFilter = "all" | DevConsoleLevel

export type DevConsoleEntry = {
  id: string
  level: DevConsoleLevel
  args: string[]
  timestamp: number
  url: string
  source: string | null
  line: number | null
  column: number | null
}

type DevConsolePanelProps = {
  entries: DevConsoleEntry[]
  filter: DevConsoleFilter
  onClear: () => void
  onFilterChange: (filter: DevConsoleFilter) => void
}

const levels: DevConsoleFilter[] = ["all", "error", "warn", "info", "log", "debug"]

function levelCount(entries: DevConsoleEntry[], level: DevConsoleLevel) {
  return entries.filter((entry) => entry.level === level).length
}

function sourceLabel(entry: DevConsoleEntry) {
  if (!entry.source && !entry.url) return null
  const source = entry.source || entry.url
  if (entry.line === null) return source
  return `${source}:${entry.line}${entry.column === null ? "" : `:${entry.column}`}`
}

export function DevConsolePanel({ entries, filter, onClear, onFilterChange }: DevConsolePanelProps) {
  const visible = filter === "all" ? entries : entries.filter((entry) => entry.level === filter)
  const errors = levelCount(entries, "error")
  const warnings = levelCount(entries, "warn")

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="dev-console-panel">
      <div className="flex flex-wrap items-center gap-2 border-y px-4 py-2">
        <p aria-live="polite" className="mr-auto text-sm text-muted-foreground">
          {entries.length} total · {errors} errors · {warnings} warnings
        </p>
        <Select
          onValueChange={(value) => {
            if (value && levels.includes(value as DevConsoleFilter)) onFilterChange(value as DevConsoleFilter)
          }}
          value={filter}
        >
          <SelectTrigger aria-label="Filter developer console" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {levels.map((level) => (
                <SelectItem key={level} value={level}>
                  {level === "all" ? "All messages" : level[0].toUpperCase() + level.slice(1)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button disabled={!entries.length} onClick={onClear} size="sm" type="button" variant="outline">
          <PlatformIcon data-icon="inline-start" icon={Trash2} />
          Clear
        </Button>
      </div>

      {!entries.length ? (
        <Empty className="min-h-64 flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><PlatformIcon icon={TerminalSquare} /></EmptyMedia>
            <EmptyTitle>No console messages yet</EmptyTitle>
            <EmptyDescription>
              Messages forwarded by the running app appear here. Older child apps may need the Usernode console forwarder.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !visible.length ? (
        <Empty className="min-h-64 flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><PlatformIcon icon={TerminalSquare} /></EmptyMedia>
            <EmptyTitle>No matching messages</EmptyTitle>
            <EmptyDescription>Choose a different severity or clear the current filter.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol aria-label="Developer console messages" className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-3 font-mono text-xs">
          {visible.map((entry) => (
            <li className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b py-2 last:border-b-0" key={entry.id}>
              <Badge className="self-start" variant={entry.level === "error" ? "destructive" : "outline"}>
                {entry.level}
              </Badge>
              <div className="min-w-0">
                <p className="break-words whitespace-pre-wrap">{entry.args.join("\n")}</p>
                <div className="mt-1 flex flex-wrap gap-x-2 text-muted-foreground">
                  <time dateTime={new Date(entry.timestamp).toISOString()}>
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </time>
                  {sourceLabel(entry) ? <span className="truncate">{sourceLabel(entry)}</span> : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
