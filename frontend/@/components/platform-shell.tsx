import type { ReactNode } from "react"
import { Bell, BriefcaseBusiness, Compass, EyeOff, House, MessageCircle, Server, Settings, Shield, Trophy, UserRound } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useLocation } from "react-router-dom"

import { DevCompletionAlerts } from "@/components/dev-completion-alerts"
import { DevConsoleLayer, DevConsoleProvider } from "@/components/dev-console-provider"
import { PlatformIcon } from "@/components/platform-icon"
import { PlatformNavigation, type PlatformNavItem } from "@/components/platform-navigation"
import { ShellAttentionProvider } from "@/components/platform-menu-trigger"
import { StatusDot } from "@/components/status-dot"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarMenuBadge, SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { usePlatformShellNavigationState } from "@/components/platform-shell-navigation"
import { isAdminPreviewEnabled, setAdminPreviewEnabled } from "@/lib/admin-preview"
import {
  clearExternalLinkFailure,
  EXTERNAL_LINK_FAILURE_EVENT,
  getExternalLinkFailure,
  type ExternalLinkFailureDetail,
} from "@/lib/external-links"

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

function ExternalLinkFeedback() {
  const [failure, setFailure] = useState<ExternalLinkFailureDetail | null>(null)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    const receiveFailure = (event: Event) => {
      setRetrying(false)
      setFailure((event as CustomEvent<ExternalLinkFailureDetail>).detail)
    }
    document.addEventListener(EXTERNAL_LINK_FAILURE_EVENT, receiveFailure)
    setFailure(getExternalLinkFailure())
    return () => document.removeEventListener(EXTERNAL_LINK_FAILURE_EVENT, receiveFailure)
  }, [])

  if (!failure) return null
  const unsupported = failure.reason === "native-link-unsupported"
  const retry = failure.retry

  const retryOpen = async () => {
    if (!retry || retrying) return
    setRetrying(true)
    const opened = await retry()
    setRetrying(false)
    if (opened) {
      clearExternalLinkFailure()
      setFailure(null)
    }
  }

  return (
    <div data-slot="external-link-feedback">
      <Alert>
        <AlertTitle>{unsupported ? "Link isn’t supported here" : "Link didn’t open"}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>
            {unsupported
              ? "Open this link from a regular browser."
              : "Try again. If it still doesn’t open, use a regular browser."}
          </span>
          <span className="flex flex-wrap gap-2">
            {retry ? (
              <Button disabled={retrying} onClick={() => void retryOpen()} size="sm" type="button">
                {retrying ? "Trying again…" : "Try again"}
              </Button>
            ) : null}
            <Button
              onClick={() => {
                clearExternalLinkFailure()
                setFailure(null)
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Dismiss
            </Button>
          </span>
        </AlertDescription>
      </Alert>
    </div>
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
    <ShellAttentionProvider count={navigation.attentionCount}>
      <PlatformNavigation
        brand={{ label: "dApps", href: "/react/" }}
        items={navigationItems}
        onNavigate={closeNavigation}
        pathname={location.pathname}
      />
      {/* The inset is the one Paper on the shell Canvas. Every route renders
          its own TopBar as the first printed child, so the shell owns the
          drawer and Paper while the route owns its chrome and single h1.
          min-h comes from the sidebar wrapper so the inset margins never
          force a scrollbar. */}
      <SidebarInset className="overflow-hidden">
        <AdminPreviewBanner />
        <div
          className="relative flex min-h-0 flex-1 flex-col"
          data-slot="route-viewport"
          data-surface="print"
        >
          {children}
        </div>
        <ExternalLinkFeedback />
      </SidebarInset>
    </ShellAttentionProvider>
  )
}

export function PlatformShell({ children }: { children: ReactNode }) {
  return (
    <DevConsoleProvider>
      <TooltipProvider>
        <DevCompletionAlerts />
        <SidebarProvider data-surface="canvas">
          <PlatformShellContent>{children}</PlatformShellContent>
        </SidebarProvider>
        <DevConsoleLayer />
      </TooltipProvider>
    </DevConsoleProvider>
  )
}
