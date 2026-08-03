import type { MouseEventHandler, ReactNode } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"

type StreamRowBaseProps = {
  accessibleName: string
  anchor?: ReactNode
  className?: string
  metadata: ReactNode
  onNavigate?: MouseEventHandler<HTMLAnchorElement>
  title: ReactNode
  to: string
  trailing?: ReactNode
}

export type StreamRowProps = StreamRowBaseProps & (
  | { state?: "default"; secondaryAction?: ReactNode }
  | { state: "unread"; secondaryAction: ReactNode }
  | { state: "read"; secondaryAction?: never }
)

/**
 * A comparable stream record with one real row destination, a stable caller-owned
 * anchor, an optional quiet trailing value, and at most one sibling action. Unread
 * rows require that action, read rows forbid it, and default records may optionally
 * supply it. The DOM contract forbids nested interactive elements.
 */
export function StreamRow({
  accessibleName,
  anchor,
  className,
  metadata,
  onNavigate,
  secondaryAction,
  state = "default",
  title,
  to,
  trailing,
}: StreamRowProps) {
  const unread = state === "unread"

  return (
    <article
      className={cn("flex items-stretch border-b border-border last:border-b-0", className)}
      data-read-state={state === "default" ? undefined : state}
      data-slot="stream-row"
      data-stream-state={state}
    >
      <Link
        aria-label={accessibleName}
        className="group/stream-row-link flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:z-20 focus-visible:ring-3 focus-visible:ring-ring/30"
        data-slot="stream-row-link"
        onClick={onNavigate}
        to={to}
      >
        <span
          className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"
          data-slot="stream-row-anchor"
        >
          {anchor}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn("truncate text-base text-foreground", unread && "font-medium")} data-slot="stream-row-title">
            {title}
          </span>
          <span className="truncate text-sm text-muted-foreground" data-slot="stream-row-metadata">{metadata}</span>
        </span>
        {trailing ? <span className="shrink-0 text-right text-sm text-muted-foreground" data-slot="stream-row-trailing">{trailing}</span> : null}
      </Link>
      {secondaryAction ? (
        <span
          className="relative z-10 flex shrink-0 items-center pr-2"
          data-slot="stream-row-action"
        >
          {secondaryAction}
        </span>
      ) : null}
    </article>
  )
}
