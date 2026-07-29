import { ArrowLeft, ArrowRight } from "lucide-react"
import { Link } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
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
 * Personal, direct-launch representation of a known dApp. Collection policy,
 * filtering, and optimistic reorder persistence stay with AppsHome.
 */
export function HomeAppShortcut({ app, href, reorder, status }: HomeAppShortcutProps) {
  const presentation = appPresentationStatus(status)
  const canMoveEarlier = !!reorder && reorder.position > 0 && !reorder.disabled && !reorder.pending
  const canMoveLater = !!reorder && reorder.position < reorder.total - 1 && !reorder.disabled && !reorder.pending

  return (
    <Card className="h-full w-full" data-testid={`home-app-shortcut-${app.slug}`}>
      <CardHeader className="gap-3">
        <AppIdentity app={app} />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle className="truncate">{app.name}</CardTitle>
          {app.is_collaborator ? <Badge variant="secondary">Collaborator</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 items-center">
        <StatusDot label={presentation.label} role={presentation.role} subject={app.name} />
      </CardContent>
      <CardFooter className="gap-2">
        <Button className="min-w-0 flex-1" render={<Link aria-label={`Open ${app.name}`} to={href} />} variant="outline">
          Open
        </Button>
        {reorder ? (
          <div className="flex shrink-0 gap-1" role="group" aria-label={`Reorder ${app.name}`}>
            <Button aria-label={`Move ${app.name} earlier`} disabled={!canMoveEarlier} onClick={reorder.onMoveEarlier} size="icon-sm" type="button" variant="outline">
              <PlatformIcon icon={ArrowLeft} />
            </Button>
            <Button aria-label={`Move ${app.name} later`} disabled={!canMoveLater} onClick={reorder.onMoveLater} size="icon-sm" type="button" variant="outline">
              <PlatformIcon icon={ArrowRight} />
            </Button>
          </div>
        ) : null}
      </CardFooter>
    </Card>
  )
}
