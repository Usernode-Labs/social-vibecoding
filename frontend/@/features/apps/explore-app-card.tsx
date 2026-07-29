import { Users } from "lucide-react"
import { Link } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { StatusDot } from "@/components/status-dot"
import { AppIdentity } from "@/features/apps/app-identity"
import { appPresentationStatus, type AppPresentationStatus } from "@/features/apps/app-presentation-status"
import type { AppRecord } from "@/lib/apps-api"

export type ExploreAppCardProps = {
  app: AppRecord
  href: string
  status: AppPresentationStatus
  showCommunitySignal?: boolean
}

/**
 * Uniform browse/discovery representation. It deliberately exposes only the
 * details destination; app management belongs in the detail route.
 */
export function ExploreAppCard({ app, href, showCommunitySignal = false, status }: ExploreAppCardProps) {
  const description = app.tagline || app.description
  const presentation = appPresentationStatus(status)

  return (
    <Card className="h-full w-full" data-testid={`explore-app-card-${app.slug}`}>
      <CardHeader className="gap-3">
        <AppIdentity app={app} />
        <CardTitle className="truncate">{app.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {description ? <CardDescription className="line-clamp-2">{description}</CardDescription> : null}
        <StatusDot label={presentation.label} role={presentation.role} subject={app.name} />
        {showCommunitySignal ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <PlatformIcon data-icon="inline-start" icon={Users} />
            {app.active_users} active
          </span>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button className="w-full" render={<Link aria-label={`View details for ${app.name}`} to={href} />} variant="outline">
          View details
        </Button>
      </CardFooter>
    </Card>
  )
}
