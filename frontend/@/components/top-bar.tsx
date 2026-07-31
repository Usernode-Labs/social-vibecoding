import type { ReactNode } from "react"

import { PlatformMenuTrigger } from "@/components/platform-menu-trigger"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type TopBarProps = {
  /** The screen's name. Rendered as the screen's only h1. */
  title: string
  /** Present only on genuine nested routes; the caller owns the destination. */
  onBack?: () => void
  /**
   * Contextual actions for this screen. Keep it to one primary control plus
   * overflow — most screens need none.
   */
  action?: ReactNode
  /**
   * `flow` reserves the bar's height above route content. `overlay` floats the
   * bar over a full-bleed surface, so a hosted app owns the whole page.
   */
  placement?: "flow" | "overlay"
  className?: string
}

/**
 * The one bar every screen gets: platform menu, the screen name, contextual
 * actions, and an optional trailing Back action. Every screen renders exactly
 * one — it is the sole owner of route chrome and of the screen's h1.
 */
export function TopBar({
  action,
  className,
  onBack,
  placement = "flow",
  title,
}: TopBarProps) {
  return (
    <header
      className={cn(
        "flex min-h-14 items-center gap-2 px-3",
        placement === "overlay"
          ? "absolute inset-x-0 top-0 z-10 border-b border-border/50 bg-background/80 supports-backdrop-filter:bg-background/60 supports-backdrop-filter:backdrop-blur-md"
          : "shrink-0 border-b",
        className
      )}
      data-placement={placement}
      data-slot="top-bar"
    >
      <PlatformMenuTrigger />
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
        {title}
      </h1>
      {action || onBack ? (
        <div
          className={cn(
            // The slot owns reach for caller-provided buttons and links. Keep
            // adjacent coarse targets disjoint instead of letting later
            // actions silently steal the expanded edge.
            "flex shrink-0 items-center gap-1 pointer-coarse:gap-5 pointer-coarse:[&>div]:gap-5",
            "[&_:is(a,button)]:relative [&_:is(a,button)]:after:absolute [&_:is(a,button)]:after:top-1/2 [&_:is(a,button)]:after:left-1/2 [&_:is(a,button)]:after:size-13 [&_:is(a,button)]:after:-translate-1/2 [&_:is(a,button)]:after:content-[''] [&_:is(a,button)]:after:pointer-fine:hidden"
          )}
          data-slot="top-bar-action"
        >
          {action}
          {onBack ? (
            <Button onClick={onBack} size="sm" type="button" variant="ghost">
              Back
            </Button>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}
