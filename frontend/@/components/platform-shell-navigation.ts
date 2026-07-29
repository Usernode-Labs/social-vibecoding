import { useEffect, useState } from "react"

import type { StatusDotPresentation } from "@/components/status-dot"
import { nodePresentationStatus } from "@/features/platform/node-presentation-status"
import { getAdminUser } from "@/lib/admin-api"
import { isAdminPreviewEnabled } from "@/lib/admin-preview"
import { getNodeStatusSnapshot } from "@/lib/node-status-api"
import { getNotificationsPage } from "@/lib/notifications-api"

export type PlatformShellNavigationState = {
  attentionCount: number
  canAccessAdmin: boolean
  nodeStatus: StatusDotPresentation
}

const initialState: PlatformShellNavigationState = {
  attentionCount: 0,
  canAccessAdmin: false,
  nodeStatus: nodePresentationStatus(null),
}

/**
 * Shell-only read adapter. PlatformNavigation receives these resolved values
 * as props and never calls platform endpoints or native APIs directly.
 */
export function usePlatformShellNavigationState(): PlatformShellNavigationState {
  const [state, setState] = useState(initialState)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const previewingAsNonAdmin = isAdminPreviewEnabled()

    void getNotificationsPage(undefined, controller.signal)
      .then((page) => {
        if (active) setState((current) => ({ ...current, attentionCount: Math.max(0, page.unread || 0) }))
      })
      .catch(() => undefined)

    void getNodeStatusSnapshot(controller.signal)
      .then((snapshot) => {
        if (active) setState((current) => ({ ...current, nodeStatus: nodePresentationStatus(snapshot.node?.status) }))
      })
      .catch(() => undefined)

    if (!previewingAsNonAdmin) {
      void getAdminUser(controller.signal)
        .then(() => {
          if (active) setState((current) => ({ ...current, canAccessAdmin: true }))
        })
        .catch(() => undefined)
    }

    return () => {
      active = false
      controller.abort()
    }
  }, [])

  return state
}
