import type { ReactNode } from "react";
import {
  Bell,
  CircleUserRound,
  Cog,
  EyeOff,
  Menu,
  MessageCircle,
  Shield,
  Trophy,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { getAdminUser } from "@/lib/admin-api";
import {
  isAdminPreviewEnabled,
  setAdminPreviewEnabled,
} from "@/lib/admin-preview";
import { DevCompletionAlerts } from "@/components/dev-completion-alerts";
import {
  DevConsoleLayer,
  DevConsoleProvider,
  DevConsoleTrigger,
} from "@/components/dev-console-provider";
import { PlatformIcon } from "@/components/platform-icon";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const mainLinks = [
  { label: "Apps", href: "/react/", icon: Menu },
  { label: "Your work", href: "/react/work", icon: MessageCircle },
  { label: "Community", href: "/react/community/challenges", icon: Trophy },
];

function IconLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="relative"
            render={<a aria-label={label} href={href} />}
            size="icon"
            title={label}
            variant="ghost"
          >
            <span
              aria-hidden="true"
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
            />
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function AdminLink() {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void getAdminUser(controller.signal)
      .then(() => {
        if (!cancelled) setIsAdmin(true);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);
  return isAdmin ? (
    <IconLink href="/react/admin" label="Admin operations">
      <PlatformIcon icon={Shield} />
    </IconLink>
  ) : null;
}

function feedbackPath(pathname: string) {
  const match = pathname.match(/^\/apps\/([^/]+)(?:\/|$)/);
  return match
    ? `/react/feedback?app=${encodeURIComponent(match[1])}`
    : "/react/feedback";
}

function AdminPreviewBanner() {
  const [previewing, setPreviewing] = useState(() => isAdminPreviewEnabled());
  if (!previewing) return null;
  const restore = () => {
    setPreviewing(false);
    setAdminPreviewEnabled(false);
    window.location.reload();
  };
  return (
    <Alert className="mx-4 mt-4 sm:mx-6" data-testid="admin-preview-banner">
      <PlatformIcon icon={EyeOff} />
      <AlertTitle>Viewing as a non-admin</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        Administrator-only React affordances are hidden. Your server permissions
        have not changed.
        <Button onClick={restore} size="sm" type="button" variant="outline">
          Switch back
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function PlatformSidebar() {
  const location = useLocation();
  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <nav
        aria-label="Platform navigation"
        className="flex min-h-0 flex-1 flex-col"
      >
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={location.pathname === "/"}
                render={<a aria-label="Apps" href="/react/" />}
              >
                <span>dApps</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Platform</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {mainLinks.map(({ href, icon: Icon, label }) => (
                  <SidebarMenuItem key={label}>
                    <SidebarMenuButton
                      isActive={
                        location.pathname === href.replace("/react", "")
                      }
                      render={<a aria-label={label} href={href} />}
                    >
                      <PlatformIcon icon={Icon} />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarSeparator />
          <div className="px-2 pb-1">
            <ThemeSwitcher />
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={location.pathname === "/account/profile"}
                render={
                  <a aria-label="Account" href="/react/account/profile" />
                }
              >
                <PlatformIcon icon={CircleUserRound} />
                <span>Account</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={location.pathname === "/settings"}
                render={<a aria-label="Settings" href="/react/settings" />}
              >
                <PlatformIcon icon={Cog} />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </nav>
    </Sidebar>
  );
}

export function PlatformShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <DevConsoleProvider>
      <TooltipProvider>
        <DevCompletionAlerts />
        <SidebarProvider>
          <PlatformSidebar />
          <SidebarInset className="min-h-dvh bg-background">
            <header className="flex min-h-16 shrink-0 items-center gap-2 border-b px-4">
              <SidebarTrigger
                aria-label="Toggle navigation"
                className="relative after:pointer-fine:hidden after:absolute after:top-1/2 after:left-1/2 after:size-[max(100%,3rem)] after:-translate-1/2 after:content-['']"
              />
              <div className="min-w-0 flex-1 truncate font-semibold">dApps</div>
              <div className="flex shrink-0 items-center gap-1">
                <IconLink
                  href="/react/community/leaderboard"
                  label="Leaderboard"
                >
                  <PlatformIcon icon={Trophy} />
                </IconLink>
                <AdminLink />
                <IconLink
                  href={feedbackPath(location.pathname)}
                  label="Send feedback"
                >
                  <PlatformIcon icon={MessageCircle} />
                </IconLink>
                <IconLink href="/react/account/profile" label="Account">
                  <PlatformIcon icon={CircleUserRound} />
                </IconLink>
                <IconLink href="/react/settings" label="Settings">
                  <PlatformIcon icon={Cog} />
                </IconLink>
                <DevConsoleTrigger />
                <IconLink href="/react/notifications" label="Notifications">
                  <PlatformIcon icon={Bell} />
                </IconLink>
              </div>
            </header>
            <AdminPreviewBanner />
            {children}
          </SidebarInset>
        </SidebarProvider>
        <DevConsoleLayer />
      </TooltipProvider>
    </DevConsoleProvider>
  );
}
