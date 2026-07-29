import { useEffect, useRef, useState } from "react"

import type { ConversationMessage } from "@/features/dev/dev-conversation"
import { createDevSessionEventSource } from "@/lib/dev-chat-api"

type StreamState = "idle" | "streaming" | "error"

type SessionEvent = {
  _seq?: string | number
  type?: string
  text?: string
  error?: string
  model?: string
  log?: string
  remainingSeconds?: number
}

type StreamOptions = {
  enabled: boolean
  messages: ConversationMessage[]
  onComplete: () => void
  sessionId: string
}

function systemMessage(id: number, content: string): ConversationMessage {
  return { id, role: "system", content, metadata: null, model: null, created_at: new Date().toISOString() }
}

function assistantMessage(id: number, text: string, model?: string): ConversationMessage {
  return { id, role: "assistant", content: text, metadata: null, model: model || null, created_at: new Date().toISOString() }
}

/**
 * Read-only SSE adapter for the existing session bus. EventSource owns
 * reconnection and Last-Event-ID replay; this hook only normalizes its safe
 * presentational subset and never starts or stops a Dev turn.
 */
export function useDevSessionStream({ enabled, messages, onComplete, sessionId }: StreamOptions) {
  const [liveMessages, setLiveMessages] = useState(messages)
  const [streamState, setStreamState] = useState<StreamState>("idle")
  const seenSequences = useRef(new Set<string | number>())
  const nextTransientId = useRef(-1)
  const [buildLines, setBuildLines] = useState<string[]>([])
  const [estimate, setEstimate] = useState<string | null>(null)

  useEffect(() => {
    setLiveMessages(messages)
    setStreamState("idle")
    setBuildLines([])
    setEstimate(null)
    seenSequences.current.clear()
  }, [messages, sessionId])

  useEffect(() => {
    if (!enabled || !sessionId || typeof EventSource === "undefined") return

    const source = createDevSessionEventSource(sessionId)
    let active = true
    source.onmessage = (event) => {
      if (!active) return
      let data: SessionEvent
      try { data = JSON.parse(event.data) as SessionEvent } catch { return }
      if (data._seq && seenSequences.current.has(data._seq)) return
      if (data._seq) seenSequences.current.add(data._seq)

      if (data.type === "token") {
        setStreamState("streaming")
        // Allocate the transient record before scheduling the update. React may
        // replay this updater, so it must only compute the next array.
        const message = assistantMessage(nextTransientId.current--, data.text || "", data.model)
        setLiveMessages((current) => {
          const latest = current.at(-1)
          if (latest?.role === "assistant" && latest.id < 0) {
            return [...current.slice(0, -1), { ...latest, content: `${latest.content || ""}${data.text || ""}` }]
          }
          return [...current, message]
        })
        return
      }

      if (data.type === "mayor_reasoning") {
        setStreamState("streaming")
        const message = systemMessage(nextTransientId.current--, data.text || "Builder is planning the change…")
        setLiveMessages((current) => [...current, message])
        return
      }

      if (data.type === "status") {
        setStreamState("streaming")
        const message = systemMessage(nextTransientId.current--, data.text || "Session status updated")
        setLiveMessages((current) => [...current, message])
        return
      }

      if (data.type === "error") {
        setStreamState("error")
        const message = systemMessage(nextTransientId.current--, data.error || "The live Dev stream reported an error.")
        setLiveMessages((current) => [...current, message])
        return
      }

      if (data.type === "cc_progress") {
        setStreamState("streaming")
        if (data.text) setBuildLines((current) => [...current, data.text ?? ""].slice(-200))
        return
      }

      if (data.type === "cc_estimate") {
        setStreamState("streaming")
        setEstimate(data.text || null)
        return
      }

      if (["done", "stopped", "staging_ready", "staging_failed", "spec_updated", "checks_ready", "pr_created", "pr_updated"].includes(data.type || "")) {
        setStreamState("idle")
        onComplete()
      }
    }
    source.onerror = () => {
      // Browser-managed retries retain Last-Event-ID. A terminal failure is
      // deliberately not inferred here, because EventSource exposes no stable
      // distinction between a transient retry and an eventual reconnect.
    }
    return () => {
      active = false
      source.close()
    }
  }, [enabled, onComplete, sessionId])

  return { buildLines, estimate, liveMessages, streamState }
}
