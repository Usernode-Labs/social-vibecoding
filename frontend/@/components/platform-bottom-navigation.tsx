import type { LucideIcon } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"

export type PlatformBottomNavigationItem = {
  id: "home" | "work" | "search"
  label: "Home" | "Work" | "Search"
  href: string
  icon: LucideIcon
  match: (pathname: string) => boolean
}

export type PlatformBottomNavigationProps = {
  items: readonly [
    PlatformBottomNavigationItem,
    PlatformBottomNavigationItem,
    PlatformBottomNavigationItem,
  ]
  pathname: string
}

/**
 * Three-destination mobile switcher. The full PlatformNavigation drawer owns
 * the broader information architecture; this persistent Overlay owns only the
 * Home, Work, and Search destinations approved for frequent one-handed use.
 */
export function PlatformBottomNavigation({
  items,
  pathname,
}: PlatformBottomNavigationProps) {
  return (
    <nav
      aria-label="Mobile primary navigation"
      className="fixed z-20 flex min-h-14 items-center justify-around rounded-full border bg-paper px-2 text-foreground shadow-md md:hidden"
      data-slot="platform-bottom-navigation"
      data-surface="overlay"
      data-surface-persistence="persistent"
    >
      {items.map((item) => {
        const active = item.match(pathname)
        return (
          <a
            aria-current={active ? "page" : undefined}
            className="flex min-h-12 min-w-20 items-center justify-center gap-2 rounded-full px-3 text-sm text-fg-secondary outline-none transition-colors hover:bg-container hover:text-fg-primary aria-[current=page]:bg-container aria-[current=page]:font-medium aria-[current=page]:text-fg-primary focus-visible:ring-3 focus-visible:ring-ring/30"
            href={item.href}
            key={item.id}
          >
            <PlatformIcon icon={item.icon} />
            <span>{item.label}</span>
          </a>
        )
      })}
    </nav>
  )
}
