import type { RefObject } from "react"
import { useContext, useEffect } from "react"

import { DevConsoleContext } from "@/lib/dev-console-context"

export function useDevConsoleFrame(
  slug: string,
  iframe: RefObject<HTMLIFrameElement | null>,
  active: boolean,
  frameRevision = 0
) {
  const context = useContext(DevConsoleContext)
  if (!context) throw new Error("useDevConsoleFrame must be used inside DevConsoleProvider")
  const { registerFrame } = context
  useEffect(() => {
    const frame = active ? iframe.current?.contentWindow : null
    if (!frame) return
    return registerFrame(slug, frame)
  }, [active, frameRevision, iframe, registerFrame, slug])
}
