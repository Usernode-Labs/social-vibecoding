import { createContext, useContext, type ReactNode } from "react"

import { StatusDot } from "@/components/status-dot"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

const ShellAttentionContext = createContext(0)

/**
 * The shell publishes the unresolved attention count; the trigger renders the
 * platform's single attention dot from it. Kept beside the trigger so the
 * block owns its own context and the shell only supplies the value.
 */
export function ShellAttentionProvider({
  children,
  count,
}: {
  children: ReactNode
  count: number
}) {
  return (
    <ShellAttentionContext.Provider value={count}>
      {children}
    </ShellAttentionContext.Provider>
  )
}

/**
 * The platform menu control: the drawer trigger plus the shell's one
 * attention dot. Never a count — the drawer reveals the number.
 */
export function PlatformMenuTrigger({ className }: { className?: string }) {
  const attentionCount = useContext(ShellAttentionContext)
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <SidebarTrigger
        aria-label="Toggle navigation"
        className="relative after:pointer-fine:hidden after:absolute after:top-1/2 after:left-1/2 after:size-[max(100%,3rem)] after:-translate-1/2 after:content-['']"
      />
      {attentionCount > 0 ? (
        <StatusDot
          className="pointer-events-none absolute -top-0.5 -right-0.5"
          label="Needs attention"
          role="attention"
          showLabel={false}
          size="sm"
          subject="Activity"
        />
      ) : null}
    </span>
  )
}
