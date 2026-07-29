import type { ReactNode } from "react"
import { Bell, BriefcaseBusiness, Compass, EyeOff, House, MessageCircle, Server, Settings, Shield, Trophy, UserRound } from "lucide-react"
import { useMemo, useState } from "react"
import { useLocation } from "react-router-dom"

import { DevCompletionAlerts } from "@/components/dev-completion-alerts"
import { DevConsoleLayer, DevConsoleProvider, DevConsoleTrigger } from "@/components/dev-console-provider"
import { PlatformIcon } from "@/components/platform-icon"
import { PlatformNavigation, type PlatformNavItem } from "@/components/platform-navigation"
import { StatusDot } from "@/components/status-dot"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarMenuBadge, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { usePlatformShellNavigationState } from "@/components/platform-shell-navigation"
import { isAdminPreviewEnabled, setAdminPreviewEnabled } from "@/lib/admin-preview"

function route(path: string) {
  return (pathname: string) => pathname === path || pathname.startsWith(`${path}/`)
}

function AdminPreviewBanner() {
  const [previewing, setPreviewing] = useState(() => isAdminPreviewEnabled())
  if (!previewing) return null
  const restore = () => {
    setPreviewing(false)
    setAdminPreviewEnabled(false)
    window.location.reload()
  }
  return (
    <Alert className="mx-4 mt-4 sm:mx-6" data-testid="admin-preview-banner">
      <PlatformIcon icon={EyeOff} />
      <AlertTitle>Viewing as a non-admin</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        Administrator-only React affordances are hidden. Your server permissions have not changed.
        <Button onClick={restore} size="sm" type="button" variant="outline">Switch back</Button>
      </AlertDescription>
    </Alert>
  )
}

function PlatformShellContent({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigation = usePlatformShellNavigationState()
  const { isMobile, setOpenMobile } = useSidebar()

  const navigationItems = useMemo(() => [
    { id: "home", label: "Home", href: "/react/", icon: House, match: (pathname: string) => pathname === "/" },
    { id: "explore", label: "Explore", href: "/react/explore", icon: Compass, match: route("/explore") },
    { id: "work", label: "Work", href: "/react/work", icon: BriefcaseBusiness, match: route("/work") },
    { id: "challenges", label: "Challenges", href: "/react/community/challenges", icon: Trophy, match: route("/community/challenges") },
    {
      id: "activity",
      label: "Activity",
      href: "/react/notifications",
      icon: Bell,
      match: route("/notifications"),
      trailing: navigation.attentionCount > 0 ? <SidebarMenuBadge aria-label={`${navigation.attentionCount} items need attention`}>{navigation.attentionCount}</SidebarMenuBadge> : undefined,
    },
    {
      id: "node",
      label: "Node",
      href: "/react/node-status",
      icon: Server,
      match: route("/node-status"),
      group: "node" as const,
      trailing: <StatusDot {...navigation.nodeStatus} showLabel={false} size="sm" subject="Node" />,
    },
    { id: "account", label: "Account", href: "/react/account/profile", icon: UserRound, match: route("/account"), group: "utility" as const },
    { id: "settings", label: "Settings", href: "/react/settings", icon: Settings, match: (pathname: string) => pathname === "/settings", group: "utility" as const },
    { id: "feedback", label: "Send feedback", href: "/react/feedback", icon: MessageCircle, match: route("/feedback"), group: "utility" as const },
    { id: "admin", label: "Admin", href: "/react/admin", icon: Shield, match: route("/admin"), group: "utility" as const, visible: navigation.canAccessAdmin },
  ] satisfies readonly PlatformNavItem[], [navigation.attentionCount, navigation.canAccessAdmin, navigation.nodeStatus])

  const closeNavigation = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <>
      <PlatformNavigation
        brand={{ label: "dApps", href: "/react/" }}
        items={navigationItems}
        onNavigate={closeNavigation}
        pathname={location.pathname}
      />
      <SidebarInset className="min-h-dvh bg-background">
        <header className="flex min-h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger
            aria-label="Toggle navigation"
            className="relative size-[max(100%,3rem)] after:pointer-fine:hidden after:absolute after:top-1/2 after:left-1/2 after:size-[max(100%,3rem)] after:-translate-1/2 after:content-['']"
          >
            {navigation.attentionCount > 0 ? <StatusDot className="pointer-events-none absolute top-1 right-1" label="Needs attention" role="attention" showLabel={false} size="sm" subject="Activity" /> : null}
          </SidebarTrigger>
          <div className="min-w-0 flex-1 truncate font-semibold">dApps</div>
          <DevConsoleTrigger />
        </header>
        <AdminPreviewBanner />
        {children}
      </SidebarInset>
    </>
  )
}

export function PlatformShell({ children }: { children: ReactNode }) {
  return (
    <DevConsoleProvider>
      <TooltipProvider>
        <DevCompletionAlerts />
        <SidebarProvider>
          <PlatformShellContent>{children}</PlatformShellContent>
        </SidebarProvider>
        <DevConsoleLayer />
      </TooltipProvider>
    </DevConsoleProvider>
  )
}
