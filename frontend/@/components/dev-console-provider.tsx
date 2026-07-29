import type { ReactNode } from "react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { TerminalSquare } from "lucide-react"

import type { DevConsoleEntry, DevConsoleFilter, DevConsoleLevel } from "@/components/dev-console-panel"
import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DEV_CONSOLE_MODE_EVENT,
  getDevConsoleMode,
  type DevConsoleMode,
} from "@/lib/browser-preferences"
import { DevConsoleContext, type DevConsoleContextValue, useDevConsoleContext } from "@/lib/dev-console-context"

const LazyDevConsoleSheet = lazy(async () => import("@/components/dev-console-sheet"))

const SENTINEL = "__usernodeDevConsole"
const MAX_ENTRIES = 500

type ActiveFrame = { slug: string; frame: Window }

function stringifyArgument(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parseEntry(value: unknown, id: string): DevConsoleEntry | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if (row.sentinel !== SENTINEL) return null
  const supported = new Set<DevConsoleLevel>(["error", "warn", "info", "log", "debug"])
  const level = typeof row.level === "string" && supported.has(row.level as DevConsoleLevel)
    ? row.level as DevConsoleLevel
    : "log"
  const args = Array.isArray(row.args) ? row.args.map(stringifyArgument) : [stringifyArgument(row.args)]
  return {
    id,
    level,
    args,
    timestamp: Number.isFinite(Number(row.ts)) ? Number(row.ts) : Date.now(),
    url: typeof row.url === "string" ? row.url : "",
    source: typeof row.source === "string" ? row.source : null,
    line: numberOrNull(row.line),
    column: numberOrNull(row.col),
  }
}

export function DevConsoleProvider({ children }: { children: ReactNode }) {
  const buffers = useRef(new Map<string, DevConsoleEntry[]>())
  const sequence = useRef(0)
  const [active, setActive] = useState<ActiveFrame | null>(null)
  const [entries, setEntries] = useState<DevConsoleEntry[]>([])
  const [filter, setFilter] = useState<DevConsoleFilter>("all")
  const [mode, setMode] = useState<DevConsoleMode>(getDevConsoleMode)
  const [open, setOpenState] = useState(false)
  const [unseenErrors, setUnseenErrors] = useState(0)

  useEffect(() => {
    const syncMode = () => setMode(getDevConsoleMode())
    window.addEventListener("storage", syncMode)
    window.addEventListener(DEV_CONSOLE_MODE_EVENT, syncMode)
    return () => {
      window.removeEventListener("storage", syncMode)
      window.removeEventListener(DEV_CONSOLE_MODE_EVENT, syncMode)
    }
  }, [])

  useEffect(() => {
    setEntries(active ? [...(buffers.current.get(active.slug) || [])] : [])
    setUnseenErrors(0)
    setFilter("all")
    if (!active) setOpenState(false)
  }, [active])

  useEffect(() => {
    if (!active) return
    const receive = (event: MessageEvent) => {
      if (event.source !== active.frame) return
      const entry = parseEntry(event.data, `${active.slug}:${Date.now()}:${sequence.current++}`)
      if (!entry) return
      const next = [...(buffers.current.get(active.slug) || []), entry].slice(-MAX_ENTRIES)
      buffers.current.set(active.slug, next)
      setEntries(next)
      if (entry.level === "error" && !open) setUnseenErrors((count) => count + 1)
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [active, open])

  const registerFrame = useCallback((slug: string, frame: Window) => {
    const registered = { slug, frame }
    setActive(registered)
    return () => setActive((current) => current?.frame === frame ? null : current)
  }, [])

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    if (next) setUnseenErrors(0)
  }, [])

  const clear = useCallback(() => {
    if (!active) return
    buffers.current.set(active.slug, [])
    setEntries([])
    setUnseenErrors(0)
  }, [active])

  const value = useMemo<DevConsoleContextValue>(() => ({
    entries,
    filter,
    mode,
    open,
    unseenErrors,
    visible: Boolean(active) && (mode === "always" || entries.some((entry) => entry.level === "error") || open),
    clear,
    registerFrame,
    setFilter,
    setOpen,
  }), [active, clear, entries, filter, mode, open, registerFrame, setOpen, unseenErrors])

  return <DevConsoleContext.Provider value={value}>{children}</DevConsoleContext.Provider>
}

export function DevConsoleTrigger() {
  const { setOpen, unseenErrors, visible } = useDevConsoleContext()
  if (!visible) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Open developer console"
            className="relative"
            onClick={() => setOpen(true)}
            size="icon"
            title="Developer console"
            type="button"
            variant="ghost"
          />
        }
      >
        <PlatformIcon icon={TerminalSquare} />
        {unseenErrors ? (
          <Badge className="absolute -top-1 -right-1 min-w-5 justify-center px-1" variant="destructive">
            {unseenErrors > 99 ? "99+" : unseenErrors}
          </Badge>
        ) : null}
      </TooltipTrigger>
      <TooltipContent>Developer console</TooltipContent>
    </Tooltip>
  )
}

export function DevConsoleLayer() {
  const { open } = useDevConsoleContext()
  if (!open) return null
  return (
    <Suspense fallback={null}>
      <LazyDevConsoleSheet />
    </Suspense>
  )
}
