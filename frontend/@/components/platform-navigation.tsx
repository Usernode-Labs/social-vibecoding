import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"

export type PlatformNavItem = {
  id: string
  label: string
  href: string
  icon: LucideIcon
  match: (pathname: string) => boolean
  group?: "primary" | "node" | "utility"
  visible?: boolean
  trailing?: ReactNode
}

export type PlatformNavigationProps = {
  items: readonly PlatformNavItem[]
  pathname: string
  brand: { label: "dApps"; href: string }
  onNavigate?: () => void
}

function NavigationItems({
  items,
  onNavigate,
  pathname,
}: Pick<PlatformNavigationProps, "onNavigate" | "pathname"> & {
  items: readonly PlatformNavItem[]
}) {
  return (
    <SidebarMenu>
      {items.map((item) => {
        const active = item.match(pathname)
        return (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton
              isActive={active}
              render={
                <a
                  aria-current={active ? "page" : undefined}
                  href={item.href}
                  onClick={onNavigate}
                />
              }
              tooltip={item.label}
            >
              <PlatformIcon icon={item.icon} />
              <span>{item.label}</span>
              {item.trailing ? (
                <span className="ml-auto flex shrink-0 items-center">{item.trailing}</span>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}

/**
 * Props-only platform navigation. Route, authorization, attention, and node
 * state adapters decide which items are supplied; this view only presents and
 * matches them through the official sidebar primitive.
 */
export function PlatformNavigation({
  brand,
  items,
  onNavigate,
  pathname,
}: PlatformNavigationProps) {
  const visibleItems = items.filter((item) => item.visible !== false)
  const primaryItems = visibleItems.filter((item) => !item.group || item.group === "primary")
  const nodeItems = visibleItems.filter((item) => item.group === "node")
  const utilityItems = visibleItems.filter((item) => item.group === "utility")

  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <nav aria-label="Platform navigation" className="flex min-h-0 flex-1 flex-col">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <a
                    href={brand.href}
                    onClick={onNavigate}
                  />
                }
                size="lg"
                tooltip={brand.label}
              >
                <span className="font-semibold">{brand.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <NavigationItems items={primaryItems} onNavigate={onNavigate} pathname={pathname} />
            </SidebarGroupContent>
          </SidebarGroup>
          {nodeItems.length ? (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupContent>
                  <NavigationItems items={nodeItems} onNavigate={onNavigate} pathname={pathname} />
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          ) : null}
        </SidebarContent>
        {utilityItems.length ? (
          <SidebarFooter>
            <SidebarSeparator />
            <NavigationItems items={utilityItems} onNavigate={onNavigate} pathname={pathname} />
          </SidebarFooter>
        ) : null}
      </nav>
    </Sidebar>
  )
}
