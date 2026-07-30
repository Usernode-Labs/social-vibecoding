import { ArrowLeft, ArrowRight } from "lucide-react"
import { Link } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { StatusDot } from "@/components/status-dot"
import { AppIdentity } from "@/features/apps/app-identity"
import { appPresentationStatus, type AppPresentationStatus } from "@/features/apps/app-presentation-status"
import type { AppRecord } from "@/lib/apps-api"

export type HomeAppShortcutProps = {
  app: AppRecord
  href: string
  status: AppPresentationStatus
  reorder?: {
    position: number
    total: number
    disabled?: boolean
    pending?: boolean
    onMoveEarlier: () => void
    onMoveLater: () => void
  }
}

/**
 * Personal, direct-launch representation of a known dApp: the whole tile is
 * the launch target, healthy status stays quiet, and only reorder mode adds
 * controls. Collection policy, filtering, and optimistic reorder persistence
 * stay with the Home route.
 */
export function HomeAppShortcut({ app, href, reorder, status }: HomeAppShortcutProps) {
  const presentation = appPresentationStatus(status)
  const showStatus = presentation.role !== "positive"
  const canMoveEarlier = !!reorder && reorder.position > 0 && !reorder.disabled && !reorder.pending
  const canMoveLater = !!reorder && reorder.position < reorder.total - 1 && !reorder.disabled && !reorder.pending

  return (
    <Card className="relative h-full w-full" data-testid={`home-app-shortcut-${app.slug}`} size="sm">
      <Link
        aria-label={`Open ${app.name}`}
        className="absolute inset-0 rounded-4xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        to={href}
      >
        <span className="sr-only">Open {app.name}</span>
      </Link>
      <CardHeader className="gap-3">
        <AppIdentity app={app} />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle className="truncate">{app.name}</CardTitle>
          {app.is_collaborator ? <Badge variant="secondary">Collaborator</Badge> : null}
        </div>
        {showStatus ? <StatusDot label={presentation.label} role={presentation.role} subject={app.name} /> : null}
      </CardHeader>
      {reorder ? (
        <CardFooter>
          <div className="relative z-10 flex shrink-0 gap-1" role="group" aria-label={`Reorder ${app.name}`}>
            <Button aria-label={`Move ${app.name} earlier`} disabled={!canMoveEarlier} onClick={reorder.onMoveEarlier} size="icon-sm" type="button" variant="outline">
              <PlatformIcon icon={ArrowLeft} />
            </Button>
            <Button aria-label={`Move ${app.name} later`} disabled={!canMoveLater} onClick={reorder.onMoveLater} size="icon-sm" type="button" variant="outline">
              <PlatformIcon icon={ArrowRight} />
            </Button>
          </div>
        </CardFooter>
      ) : null}
    </Card>
  )
}
