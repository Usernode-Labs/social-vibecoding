import type { ReactNode } from "react"
import { ExternalLink, Users } from "lucide-react"
import { Link } from "react-router-dom"

import { AppIdentity } from "@/features/apps/app-identity"
import type { AppRecord } from "@/lib/apps-api"
import { appDetailsPath } from "@/lib/routes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PlatformIcon } from "@/components/platform-icon"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

export function AppCard({ app, footerActions }: { app: AppRecord; footerActions?: ReactNode }) {
  const statusLabel = "View details"
  const destination = appDetailsPath(app.slug)

  return (
    <Card className="flex h-full min-w-0 flex-col" data-testid={`app-card-${app.slug}`}>
      <CardHeader>
        <AppIdentity app={app} />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base sm:text-sm">{app.name}</CardTitle>
          {app.is_collaborator ? <Badge variant="secondary">Your app</Badge> : null}
          {app.status !== "running" ? <Badge variant="outline">{app.status.replaceAll("_", " ")}</Badge> : null}
        </div>
        <CardDescription className="text-base text-pretty sm:text-sm">{app.tagline || app.description || "Open this app in Usernode."}</CardDescription>
        <div className="flex items-center gap-1 text-base text-muted-foreground tabular-nums sm:text-sm">
          <PlatformIcon data-icon="inline-start" icon={Users} />
          <span>{app.active_users} active</span>
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button className="min-w-0 flex-1" render={<Link aria-label={`${statusLabel} ${app.name}`} to={destination} />} variant="outline">
          <PlatformIcon data-icon="inline-start" icon={ExternalLink} />
          {statusLabel}
        </Button>
        {footerActions}
      </CardFooter>
    </Card>
  )
}
