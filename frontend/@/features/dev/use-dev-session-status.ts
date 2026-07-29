import { useEffect, useState } from "react"

import { getDevSessionStatus, type DevSessionStatus } from "@/lib/dev-chat-api"

/** Read-only fallback for reload recovery while a session worker is active. */
export function useDevSessionStatus(sessionId: string, enabled: boolean) {
  const [status, setStatus] = useState<DevSessionStatus | null>(null)

  useEffect(() => {
    if (!enabled || !sessionId) return
    let cancelled = false
    let interval: number | undefined
    const load = async () => {
      try {
        const next = await getDevSessionStatus(sessionId)
        if (cancelled) return
        setStatus(next)
        if (next.busy && interval === undefined) interval = window.setInterval(() => void load(), 3000)
        if (!next.busy && interval !== undefined) {
          window.clearInterval(interval)
          interval = undefined
        }
      } catch {
        // The transcript stays usable if this non-critical recovery probe fails.
      }
    }
    void load()
    return () => {
      cancelled = true
      if (interval !== undefined) window.clearInterval(interval)
    }
  }, [enabled, sessionId])

  return status
}
