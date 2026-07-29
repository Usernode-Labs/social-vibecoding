import { useEffect } from "react"

import { notifyDevCompletion } from "@/lib/browser-preferences"
import { subscribeNotificationEvents } from "@/lib/notification-events"

/**
 * Global completion-alert consumer. The shared event adapter owns the socket;
 * this component only reacts to fully hydrated, unread completion rows.
 */
export function DevCompletionAlerts() {
  useEffect(() => subscribeNotificationEvents({
    onNotificationChange: ({ notification }) => {
      if (notification) notifyDevCompletion(notification)
    },
  }), [])
  return null
}
