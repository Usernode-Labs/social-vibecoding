import type { MouseEventHandler, ReactNode } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"

type StreamRowBaseProps = {
  accessibleName: string
  className?: string
  indicator?: ReactNode
  metadata: ReactNode
  onNavigate?: MouseEventHandler<HTMLAnchorElement>
  title: ReactNode
  to: string
}

export type StreamRowProps = StreamRowBaseProps & (
  | { state: "unread"; secondaryAction: ReactNode }
  | { state: "read"; secondaryAction?: never }
)

/**
 * A comparable stream record with one real row destination and, while unread,
 * one sibling action. The type contract forbids a dead action gutter on read
 * rows; the DOM contract forbids nested interactive elements.
 */
export function StreamRow({
  accessibleName,
  className,
  indicator,
  metadata,
  onNavigate,
  title,
  to,
  ...stateProps
}: StreamRowProps) {
  const unread = stateProps.state === "unread"

  return (
    <article
      className={cn("flex items-stretch border-b border-border last:border-b-0", className)}
      data-read-state={stateProps.state}
      data-slot="stream-row"
    >
      <Link
        aria-label={accessibleName}
        className="group/stream-row-link flex min-h-16 min-w-0 flex-1 items-start gap-3 rounded-xl px-3 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:z-20 focus-visible:ring-3 focus-visible:ring-ring/30"
        data-slot="stream-row-link"
        onClick={onNavigate}
        to={to}
      >
        <span
          className="mt-1.5 flex size-2.5 shrink-0 items-center justify-center"
          data-slot="stream-row-indicator"
        >
          {unread ? indicator : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn("truncate text-sm text-foreground", unread && "font-medium")} data-slot="stream-row-title">
            {title}
          </span>
          <span className="truncate text-sm text-muted-foreground" data-slot="stream-row-metadata">{metadata}</span>
        </span>
      </Link>
      {unread ? (
        <span
          className="relative z-10 flex shrink-0 items-center pr-2"
          data-slot="stream-row-action"
        >
          {stateProps.secondaryAction}
        </span>
      ) : null}
    </article>
  )
}
